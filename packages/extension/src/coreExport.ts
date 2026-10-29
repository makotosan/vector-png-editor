// Production export dependencies (Issue #47; TS Core switch in
// Issue #58).
//
// `validate --profile` and `build` now run in-process through the
// TypeScript Core (packages/ts-core): the profile gate is
// checkProfile with strict structure - exactly what the Core CLI's
// `validate --profile safe-svg-v1` computed - and build is the
// shared tsCore build/publish path. Neither needs a Python
// environment any more.
//
// `convert` cannot switch yet: it is the normalization route, whose
// port is Phase 2 (Issue #59). It still runs through the Core's
// versioned JSON CLI with a bounded, shell-free spawn that mirrors
// the bridge's discipline (output caps, timeout, process-tree kill,
// envelope validation) - as does `normalize` in coreNormalize.ts,
// which shares runCoreCli from this module.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsCoreError } from '../../ts-core/src/errors.ts';
import { checkProfile } from '../../ts-core/src/validate.ts';
import type { BuildOutcome } from './save.ts';
import {
  ExportCoreError, ExportUnavailableError,
  type ConvertOutcome, type ProfileValidation,
} from './export.ts';
import type { ExportPngDeps, PlainPngRenderOutcome } from './exportPng.ts';
import { buildToFile, buildVectorPngBytes, type TsCoreRuntime } from './tsCore.ts';

const PYTHON_HINT = 'Export via normalization needs the Python Core: run the command “Vector PNG: Set Up Python Environment” or set "vectorPng.corePythonPath" to a Python 3.11-3.13 with the Core installed. Nothing was written.';

type CliEnvelope = {
  protocol: 1;
  command: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

const MAX_STDOUT = 4_194_304;
const MAX_STDERR = 65_536;
const TIMEOUT_MS = 120_000;

function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 32_768 },
      () => { if (child.exitCode === null) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

// Runs one Core CLI command and returns its parsed JSON envelope. A
// non-zero exit is a normal Core answer (the envelope carries the
// error), never an exception; only launch/timeout/limit/protocol
// failures throw ExportCoreError.
export function runCoreCli(python: string, args: string[]): Promise<CliEnvelope> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'vector_png_editor', ...args], {
      shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Buffer[] = [], stderrBytes = 0, outBytes = 0;
    let failure: ExportCoreError | undefined, finished = false;
    const stop = (error: ExportCoreError) => {
      if (finished || failure) return;
      failure = error;
      killTree(child);
    };
    const timer = setTimeout(() => stop(new ExportCoreError('timeout', 'The Core request timed out')), TIMEOUT_MS);
    const cleanup = () => { finished = true; clearTimeout(timer); };
    child.on('error', (error) => {
      cleanup();
      reject(new ExportCoreError('launch-failed', `Could not start the Python Core: ${error.message}`));
    });
    child.stdout.on('data', (data: Buffer) => {
      outBytes += data.length;
      if (outBytes > MAX_STDOUT) stop(new ExportCoreError('output-limit', 'Core output exceeds the limit'));
      else if (!failure) stdout.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > MAX_STDERR) stop(new ExportCoreError('output-limit', 'Core stderr exceeds the limit'));
    });
    child.on('close', () => {
      cleanup();
      if (failure) { reject(failure); return; }
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout))) as Partial<CliEnvelope>;
        if (value.protocol !== 1 || typeof value.ok !== 'boolean')
          throw new Error('unexpected envelope');
        resolve(value as CliEnvelope);
      } catch {
        reject(new ExportCoreError('protocol-error', 'The Core returned an unreadable response'));
      }
      stdout = [];
    });
  });
}

// Human-readable warnings from a conversion report: every recorded
// accessibility loss, plus any report warning that is not the generic
// pointer at those losses.
export function warningsFromReport(report: Record<string, unknown> | undefined): string[] {
  if (!report) return [];
  const warnings: string[] = [];
  const accessibility = report.accessibility;
  if (Array.isArray(accessibility)) {
    for (const entry of accessibility) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.loss !== 'string') continue;
      const attribute = typeof record.attribute === 'string' ? record.attribute : 'attribute';
      const value = typeof record.value === 'string' ? ` "${record.value}"` : '';
      warnings.push(`Accessibility: ${attribute}${value} could not be preserved (${record.loss})`);
    }
  }
  const listed = report.warnings;
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record.code === 'accessibility-loss') continue; // detailed above
      if (typeof record.explanation === 'string') warnings.push(record.explanation);
    }
  }
  return warnings;
}

let sequence = 0;

// Runs `fn` in a fresh private temp directory and always removes it.
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-export-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type CoreExportDeps = {
  validateProfile: (source: string, width: number, height: number) => Promise<ProfileValidation>;
  build: (request: { source: string; output: string; width: number; height: number; expectedSha256?: string }) => Promise<BuildOutcome>;
  convert: (request: { source: string; output: string }) => Promise<ConvertOutcome>;
  sha256File: (path: string) => Promise<string>;
  targetExists: (path: string) => Promise<boolean>;
  renameFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
};

export function createCoreExportDeps(pythonPath: string | undefined, runtime: TsCoreRuntime): CoreExportDeps {
  const requirePython = (): string => {
    const python = pythonPath?.trim();
    if (!python) throw new ExportUnavailableError(PYTHON_HINT);
    return python;
  };
  return {
    // The profile gate, in-process. Width/height never participated
    // in the CLI's --profile verdict either (they only fed the
    // separate validate_render path), so they are accepted for the
    // deps contract and unused. An XML-level failure is a Core
    // refusal, thrown as ExportCoreError exactly as the CLI's
    // non-profile error was.
    async validateProfile(source, _width, _height): Promise<ProfileValidation> {
      let diagnostics;
      try {
        diagnostics = checkProfile(Buffer.from(source, 'utf8'), { strictStructure: true });
      } catch (error) {
        if (error instanceof TsCoreError) throw new ExportCoreError(error.code, error.message);
        throw error;
      }
      if (diagnostics.length === 0) return { valid: true };
      return { valid: false, diagnostics };
    },
    async build(request): Promise<BuildOutcome> {
      return buildToFile(runtime, {
        sourceBase64: Buffer.from(request.source, 'utf8').toString('base64'),
        output: request.output, width: request.width, height: request.height,
        overwrite: request.expectedSha256 !== undefined, expectedSha256: request.expectedSha256,
      });
    },
    async convert(request): Promise<ConvertOutcome> {
      const python = requirePython();
      return withTempDir(async (dir) => {
        const input = join(dir, 'input.svg');
        const reportPath = join(dir, 'report.json');
        await writeFile(input, request.source, 'utf8');
        const envelope = await runCoreCli(python, [
          '--request-id', `export-convert-${Date.now()}-${++sequence}`,
          'convert', input, request.output, '--report', reportPath,
        ]);
        if (!envelope.ok)
          return { ok: false, code: envelope.error?.code ?? 'unknown', message: envelope.error?.message ?? 'The Core conversion failed' };
        let report: Record<string, unknown> | undefined;
        try {
          report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
        } catch {
          report = envelope.result;
        }
        return { ok: true, warnings: warningsFromReport(report) };
      });
    },
    async sha256File(path: string): Promise<string> {
      const bytes = await readFile(path);
      return createHash('sha256').update(bytes).digest('hex');
    },
    async targetExists(path: string): Promise<boolean> {
      try { await access(path); return true; } catch { return false; }
    },
    async renameFile(from: string, to: string): Promise<void> {
      await rename(from, to);
    },
    async removeFile(path: string): Promise<void> {
      await rm(path, { force: true });
    },
  };
}

// Production rendering dependencies for the plain-PNG export
// (Issue #45): the same validate/build/convert routes as the
// vector-png export. The build route now runs entirely in-process
// and resolves the built bytes from memory - no temp file. The
// convert route still produces a temp vector-png through the
// Python Core and resolves its bytes. Either way, the stripped
// raster is the only thing the caller ever writes, and only where
// the user chose; the dialog and the final write are the host's
// (see ExportPngDeps).
export type CorePlainPngDeps = Pick<ExportPngDeps, 'validateProfile' | 'renderViaBuild' | 'renderViaConvert'>;

export function createCorePlainPngDeps(pythonPath: string | undefined, runtime: TsCoreRuntime): CorePlainPngDeps {
  const base = createCoreExportDeps(pythonPath, runtime);
  return {
    validateProfile: base.validateProfile,
    async renderViaBuild(source, width, height): Promise<PlainPngRenderOutcome> {
      try {
        const png = await buildVectorPngBytes(runtime, Buffer.from(source, 'utf8'), width, height);
        return { ok: true, png, warnings: [] };
      } catch (error) {
        if (error instanceof TsCoreError) return { ok: false, code: error.code, message: error.message };
        return { ok: false, code: 'io-error', message: error instanceof Error ? error.message : String(error) };
      }
    },
    async renderViaConvert(source): Promise<PlainPngRenderOutcome> {
      return withTempDir(async (dir) => {
        const output = join(dir, 'render.png');
        const outcome = await base.convert({ source, output });
        if (!outcome.ok) return outcome;
        return { ok: true, png: await readFile(output), warnings: outcome.warnings };
      });
    },
  };
}
