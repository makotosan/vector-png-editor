// Production export dependencies (Issue #47).
//
// `build` reuses the bridge protocol-1 runner exactly like the save
// path (coreSave.ts). `validate --profile` and `convert` cannot be
// expressed over that transport - the protocol accepts neither a
// profile gate nor a normalization report path - so they run through
// the Core's versioned JSON CLI with a bounded, shell-free spawn that
// mirrors the bridge's discipline (output caps, timeout, process-tree
// kill, envelope validation). No Python Core changes were needed.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCore, BridgeError } from '../../bridge/src/core.ts';
import type { BuildOutcome } from './save.ts';
import {
  ExportCoreError, ExportUnavailableError,
  type ConvertOutcome, type ProfileDiagnostic, type ProfileValidation,
} from './export.ts';

const PYTHON_HINT = 'Export needs the Python Core: run the command “Vector PNG: Set Up Python Environment” or set "vectorPng.corePythonPath" to a Python 3.11-3.13 with the Core installed. Nothing was written.';

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

function parseDiagnostics(details: Record<string, unknown> | undefined): ProfileDiagnostic[] {
  const list = details?.diagnostics;
  if (!Array.isArray(list)) return [];
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return list.filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null).map((d) => ({
    severity: text(d.severity) ?? 'error',
    code: text(d.code) ?? 'unknown',
    element: text(d.element),
    attribute: text(d.attribute),
    line: num(d.line),
    column: num(d.column),
    message: text(d.message) ?? 'Profile diagnostic',
    suggestion: text(d.suggestion),
  }));
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

export type CoreExportDeps = {
  validateProfile: (source: string, width: number, height: number) => Promise<ProfileValidation>;
  build: (request: { source: string; output: string; width: number; height: number; expectedSha256?: string }) => Promise<BuildOutcome>;
  convert: (request: { source: string; output: string }) => Promise<ConvertOutcome>;
  sha256File: (path: string) => Promise<string>;
  targetExists: (path: string) => Promise<boolean>;
  renameFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
};

export function createCoreExportDeps(pythonPath: string | undefined): CoreExportDeps {
  const requirePython = (): string => {
    const python = pythonPath?.trim();
    if (!python) throw new ExportUnavailableError(PYTHON_HINT);
    return python;
  };
  const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), 'vpe-export-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return {
    async validateProfile(source, width, height): Promise<ProfileValidation> {
      const python = requirePython();
      return withTempDir(async (dir) => {
        const input = join(dir, 'input.svg');
        await writeFile(input, source, 'utf8');
        const envelope = await runCoreCli(python, [
          '--request-id', `export-validate-${Date.now()}-${++sequence}`,
          'validate', input, '--profile', 'safe-svg-v1',
          '--width', String(width), '--height', String(height),
        ]);
        if (envelope.ok) return { valid: true };
        if (envelope.error?.code === 'unsupported-profile')
          return { valid: false, diagnostics: parseDiagnostics(envelope.error.details) };
        throw new ExportCoreError(envelope.error?.code ?? 'unknown', envelope.error?.message ?? 'The Core rejected the source');
      });
    },
    async build(request): Promise<BuildOutcome> {
      const python = requirePython();
      let response;
      try {
        response = await runCore(python, {
          protocol: 1, command: 'build', request_id: `export-${Date.now()}-${++sequence}`,
          source_base64: Buffer.from(request.source, 'utf8').toString('base64'),
          output: request.output, width: request.width, height: request.height,
          overwrite: request.expectedSha256 !== undefined, expected_sha256: request.expectedSha256,
        });
      } catch (error) {
        if (error instanceof BridgeError) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
      if (!response.response.ok)
        return { ok: false, code: response.response.error?.code ?? 'unknown', message: response.response.error?.message ?? 'The Core rejected the export' };
      const backup = response.response.result?.backup;
      return { ok: true, backup: typeof backup === 'string' ? backup : null };
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
