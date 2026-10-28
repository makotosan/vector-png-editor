import type { BuildOutcome } from './save.ts';

// Export an SVG source as a vector-png (Issue #47), framework-free so
// the flow can be unit-tested with fake Core dependencies.
//
// Two Core routes, chosen by the source - never silently:
// - A source that passes `validate --profile safe-svg-v1` is exported
//   with the Core `build` command, reusing the save path's revision
//   token discipline: an existing target is replaced only after an
//   explicit user confirmation and only under its current SHA-256, so
//   a race surfaces as a conflict instead of a silent clobber.
// - A source that fails the profile gate writes NOTHING until the user
//   explicitly picks the normalization route; only then does the Core
//   `convert` command (normalization with its render gate, then build)
//   run. `convert` is strictly no-clobber, so an existing target is
//   first moved aside and restored verbatim if the conversion fails -
//   a failed or declined export never leaves a partial or replaced PNG.
// The source itself is never written by an export, including when it
// carries unsaved edits: the export consumes the given source text and
// saves nothing back.

export type ProfileDiagnostic = {
  severity: string;
  code: string;
  element: string | null;
  attribute: string | null;
  line: number | null;
  column: number | null;
  message: string;
  suggestion: string | null;
};

export type ProfileValidation =
  | { valid: true }
  | { valid: false; diagnostics: ProfileDiagnostic[] };

export type ConvertOutcome =
  | { ok: true; warnings: string[] }
  | { ok: false; code: string; message: string };

// The Core was not reachable at all (no Python configured, launch
// failure, timeout, protocol violation). `code` is machine-readable.
export class ExportCoreError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export class ExportUnavailableError extends ExportCoreError {
  constructor(message: string) { super('unavailable', message); }
}

export type ExportDeps = {
  // Core `validate --profile safe-svg-v1` over the given source text.
  // Rejects with ExportCoreError when the Core cannot run at all.
  validateProfile: (source: string, width: number, height: number) => Promise<ProfileValidation>;
  // Core `build`. When `expectedSha256` is given the build overwrites
  // the target under that revision token; otherwise it must not exist.
  build: (request: { source: string; output: string; width: number; height: number; expectedSha256?: string }) => Promise<BuildOutcome>;
  // Core `convert` (normalization route). The target must not exist
  // when this runs; the orchestration guarantees that.
  convert: (request: { source: string; output: string }) => Promise<ConvertOutcome>;
  sha256File: (path: string) => Promise<string>;
  targetExists: (path: string) => Promise<boolean>;
  renameFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  // UI: asks the user to confirm replacing the existing target PNG.
  confirmOverwrite: (targetPath: string) => Promise<boolean>;
  // UI: presents the profile diagnostics and asks whether to take the
  // explicit normalization route. Resolves 'normalize' only on an
  // explicit user choice.
  presentDiagnostics: (diagnostics: ProfileDiagnostic[]) => Promise<'normalize' | 'cancel'>;
};

export type ExportInput = {
  source: string;
  targetPath: string;
  width: number;
  height: number;
};

export type ExportResult =
  | { status: 'exported'; via: 'build' | 'convert'; targetPath: string; warnings: string[] }
  | { status: 'invalid'; diagnostics: ProfileDiagnostic[] }
  | { status: 'cancelled-overwrite'; targetPath: string }
  | { status: 'failed'; stage: 'validate' | 'build' | 'convert'; code: string; message: string };

let backupSequence = 0;

// The aside-copy of a pre-existing target during a `convert` run lives
// next to the target (same filesystem, so the renames are atomic) and
// is removed or restored before the export settles.
export function backupPathFor(targetPath: string): string {
  return `${targetPath}.vpe-export-backup-${process.pid}-${++backupSequence}`;
}

// One line per diagnostic for documents and output channels:
// `line:column severity code element/attribute - message (suggestion)`.
export function formatProfileDiagnostics(diagnostics: ProfileDiagnostic[]): string {
  return diagnostics.map((d) => {
    const where = d.line !== null ? `line ${d.line}, column ${d.column ?? 0}` : 'line ?, column ?';
    const subject = d.element
      ? (d.attribute ? `element <${d.element}>, attribute ${d.attribute}` : `element <${d.element}>`)
      : (d.attribute ? `attribute ${d.attribute}` : 'document');
    const hint = d.suggestion ? ` Suggestion: ${d.suggestion}` : '';
    return `${where}: ${d.severity} ${d.code} (${subject}) - ${d.message}.${hint}`;
  }).join('\n');
}

function failure(stage: 'validate' | 'build' | 'convert', error: unknown): ExportResult {
  if (error instanceof ExportCoreError) return { status: 'failed', stage, code: error.code, message: error.message };
  return { status: 'failed', stage, code: 'io-error', message: error instanceof Error ? error.message : String(error) };
}

export async function exportSvgAsVectorPng(deps: ExportDeps, input: ExportInput): Promise<ExportResult> {
  const { source, targetPath, width, height } = input;
  let validation: ProfileValidation;
  try {
    validation = await deps.validateProfile(source, width, height);
  } catch (error) {
    return failure('validate', error);
  }

  if (validation.valid) {
    try {
      let expectedSha256: string | undefined;
      if (await deps.targetExists(targetPath)) {
        if (!await deps.confirmOverwrite(targetPath)) return { status: 'cancelled-overwrite', targetPath };
        expectedSha256 = await deps.sha256File(targetPath);
      }
      const outcome = await deps.build({ source, output: targetPath, width, height, expectedSha256 });
      if (!outcome.ok) return { status: 'failed', stage: 'build', code: outcome.code, message: outcome.message };
      return { status: 'exported', via: 'build', targetPath, warnings: [] };
    } catch (error) {
      return failure('build', error);
    }
  }

  // Not safe-svg-v1: nothing is written unless the user explicitly
  // picks the normalization route after seeing the diagnostics.
  const choice = await deps.presentDiagnostics(validation.diagnostics);
  if (choice !== 'normalize') return { status: 'invalid', diagnostics: validation.diagnostics };

  let backupPath: string | undefined;
  const restoreBackup = async (): Promise<void> => {
    if (!backupPath) return;
    if (await deps.targetExists(targetPath)) await deps.removeFile(targetPath);
    if (await deps.targetExists(backupPath)) await deps.renameFile(backupPath, targetPath);
  };
  try {
    const exists = await deps.targetExists(targetPath);
    if (exists && !await deps.confirmOverwrite(targetPath)) return { status: 'cancelled-overwrite', targetPath };
    if (exists) {
      backupPath = backupPathFor(targetPath);
      await deps.renameFile(targetPath, backupPath);
    }
    const outcome = await deps.convert({ source, output: targetPath });
    if (!outcome.ok) {
      // Restore the pre-existing target verbatim; a partial output
      // from the failed conversion never survives.
      await restoreBackup();
      return { status: 'failed', stage: 'convert', code: outcome.code, message: outcome.message };
    }
    if (backupPath) await deps.removeFile(backupPath);
    return { status: 'exported', via: 'convert', targetPath, warnings: outcome.warnings };
  } catch (error) {
    try { await restoreBackup(); } catch { /* the failure below names the original error */ }
    return failure('convert', error);
  }
}
