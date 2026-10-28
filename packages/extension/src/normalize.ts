import type { SourceHistory } from './history.ts';
import { ExportCoreError } from './export.ts';

// Explicit SVG normalization for open `.svg` documents (Issue #47
// follow-up), framework-free so the flow can be unit-tested.
//
// Normalization is a deliberate, user-invoked operation - never an
// automatic step of open, save or export. The Core `normalize`
// command runs on the document's current source (unsaved edits
// included) with its before/after rendering gate, so a success
// renders pixel-identically to the original. The normalized text is
// then applied to the document as an ordinary undoable edit: it lands
// dirty, saves through the normal save flow, and one undo returns the
// pre-normalization source. A failure changes nothing; a
// byte-identical result is reported as already normalized and makes
// no edit at all.

export type NormalizeSummary = {
  appliedDeclarations: number;
  expandedMarkers: number;
  styleElements: number;
  classAttributes: number;
  inlineStyles: number;
  // Accessibility attributes migrated to an equivalent construct,
  // e.g. "aria-labelledby -> title".
  migrations: string[];
  // Recorded semantic losses, human-readable. Never empty when the
  // report records a loss: normalization must not look silent-lossless.
  losses: string[];
};

export type NormalizeCoreOutcome =
  | { ok: true; output: string; summary: NormalizeSummary }
  | { ok: false; code: string; message: string; errors: string[] };

export type NormalizeResult =
  | { status: 'normalized'; source: string; summary: NormalizeSummary }
  | { status: 'already-normalized' }
  | { status: 'failed'; code: string; message: string; errors: string[] };

export type NormalizeDeps = {
  // Core `normalize` over the given source text. Rejects with
  // ExportCoreError when the Core cannot run at all.
  normalize: (source: string) => Promise<NormalizeCoreOutcome>;
};

export async function normalizeSourceText(deps: NormalizeDeps, source: string): Promise<NormalizeResult> {
  let outcome: NormalizeCoreOutcome;
  try {
    outcome = await deps.normalize(source);
  } catch (error) {
    if (error instanceof ExportCoreError)
      return { status: 'failed', code: error.code, message: error.message, errors: [] };
    return { status: 'failed', code: 'io-error', message: error instanceof Error ? error.message : String(error), errors: [] };
  }
  if (!outcome.ok)
    return { status: 'failed', code: outcome.code, message: outcome.message, errors: outcome.errors };
  if (outcome.output === source) return { status: 'already-normalized' };
  return { status: 'normalized', source: outcome.output, summary: outcome.summary };
}

// The slice of the document model the application step needs; the
// provider's document satisfies it structurally.
export type EditableDocument = {
  history: SourceHistory;
  pendingSource: string | undefined;
  syncSource: (source: string) => void;
};

// Applies a normalized source as one ordinary edit: recorded in the
// history (so the change is dirty and undoable), made pending and
// synced to every panel. Returns false when the history refused the
// edit (identical snapshot), in which case nothing changed.
export function applyNormalizedEdit(document: EditableDocument, next: string): boolean {
  if (!document.history.recordEdit(next, { now: Date.now(), coalesceKey: 'normalize-svg' })) return false;
  document.pendingSource = next;
  document.syncSource(next);
  return true;
}

// One-line summary for the success notification: what the
// normalization actually did, from the conversion report.
export function formatNormalizeSummary(summary: NormalizeSummary): string {
  const parts = [
    `${summary.appliedDeclarations} declaration(s) materialized`,
    `${summary.expandedMarkers} marker(s) expanded`,
  ];
  if (summary.styleElements > 0) parts.push(`${summary.styleElements} style element(s) removed`);
  if (summary.classAttributes > 0) parts.push(`${summary.classAttributes} class attribute(s) resolved`);
  if (summary.inlineStyles > 0) parts.push(`${summary.inlineStyles} inline style(s) resolved`);
  if (summary.migrations.length > 0) parts.push(`accessibility migrated (${summary.migrations.join(', ')})`);
  return parts.join(', ');
}

// The structured failure lines for a diagnostics document:
// `code (stage): explanation`, one per report error.
export function formatNormalizeErrors(errors: string[]): string {
  return errors.join('\n');
}
