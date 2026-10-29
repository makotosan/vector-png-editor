// Production export dependencies (Issue #47; TS Core switch in
// Issues #58 and #59).
//
// Every route now runs in-process through the TypeScript Core
// (packages/ts-core); no editor feature needs a Python environment
// any more. `validate --profile` is checkProfile with strict
// structure - exactly what the Core CLI's `validate --profile
// safe-svg-v1` computed - and `build` is the shared tsCore
// build/publish path. `convert` is the normalization route:
// ts-core's normalizeDocument (the gated normalization port) feeds
// its output to the same build path and publishes with the Core's
// no-clobber discipline; the move-aside/restore-on-failure handling
// of a pre-existing target lives in the orchestration (export.ts),
// unchanged.
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsCoreError } from '../../ts-core/src/errors.ts';
import {
  normalizeDocument,
  type ConversionReport,
} from '../../ts-core/src/normalize.ts';
import { checkProfile } from '../../ts-core/src/validate.ts';
import type { BuildOutcome } from './save.ts';
import {
  ExportCoreError,
  type ConvertOutcome, type ProfileValidation,
} from './export.ts';
import type { ExportPngDeps, PlainPngRenderOutcome } from './exportPng.ts';
import { buildToFile, buildVectorPngBytes, publishBytes, type TsCoreRuntime } from './tsCore.ts';

// Human-readable warnings from a conversion report: every recorded
// accessibility loss, plus any report warning that is not the generic
// pointer at those losses.
export function warningsFromReport(report: ConversionReport | undefined): string[] {
  if (!report) return [];
  const warnings: string[] = [];
  for (const record of report.accessibility) {
    if (typeof record.loss !== 'string') continue;
    const value = record.value ? ` "${record.value}"` : '';
    warnings.push(`Accessibility: ${record.attribute}${value} could not be preserved (${record.loss})`);
  }
  for (const record of report.warnings) {
    if (record.code === 'accessibility-loss') continue; // detailed above
    warnings.push(record.explanation);
  }
  return warnings;
}

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

export function createCoreExportDeps(runtime: TsCoreRuntime): CoreExportDeps {
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
    // The normalization route, in-process: normalize with the
    // render gate, build a vector-png from the normalized source at
    // the gate's viewport, and publish it without clobbering (the
    // orchestration guarantees the target does not exist; a race
    // still resolves as the Core's output-exists). Every refusal -
    // normalization, build, publish - resolves as a failed outcome
    // with the Core's code, as the CLI envelope did; filesystem
    // failures resolve as 'io-error', the CLI's own mapping.
    async convert(request): Promise<ConvertOutcome> {
      try {
        const { fonts, defaultFamily } = await runtime.fonts;
        const { output, report } = await normalizeDocument(Buffer.from(request.source, 'utf8'), {
          fonts, defaultFontFamily: defaultFamily, sansSerifFamily: defaultFamily,
        });
        const render = report.render;
        if (render === null || typeof render !== 'object') {
          throw new TsCoreError('render-failed', 'Normalization produced no render record');
        }
        const [width, height] = render.viewport;
        const bytes = await buildVectorPngBytes(runtime, output, width, height);
        await publishBytes(bytes, request.output, { overwrite: false });
        return { ok: true, warnings: warningsFromReport(report) };
      } catch (error) {
        if (error instanceof TsCoreError) return { ok: false, code: error.code, message: error.message };
        return { ok: false, code: 'io-error', message: error instanceof Error ? error.message : String(error) };
      }
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
// vector-png export. The build route runs entirely in-process and
// resolves the built bytes from memory - no temp file. The convert
// route also runs in-process now; it still produces a temp
// vector-png (in a private temp directory) whose bytes are then
// resolved, because the raster is stripped from a built container.
// Either way, the stripped raster is the only thing the caller ever
// writes, and only where the user chose; the dialog and the final
// write are the host's (see ExportPngDeps).
export type CorePlainPngDeps = Pick<ExportPngDeps, 'validateProfile' | 'renderViaBuild' | 'renderViaConvert'>;

export function createCorePlainPngDeps(runtime: TsCoreRuntime): CorePlainPngDeps {
  const base = createCoreExportDeps(runtime);
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
