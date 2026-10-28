import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceHistory } from '../src/history.ts';
import {
  applyNormalizedEdit, formatNormalizeSummary, normalizeSourceText,
} from '../src/normalize.ts';
import { createCoreNormalizeDeps, summaryFromReport } from '../src/coreNormalize.ts';
import { ExportUnavailableError } from '../src/export.ts';

const ORIGINAL = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><style>.a{fill:red}</style><rect class="a" width="8" height="8"/></svg>';
const NORMALIZED = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
const SUMMARY = {
  appliedDeclarations: 3, expandedMarkers: 1, styleElements: 1, classAttributes: 1, inlineStyles: 0,
  migrations: ['aria-labelledby -> title'],
  losses: ['Accessibility: role "img" could not be preserved (unsupported-semantics)'],
};

// A document double whose history is the real SourceHistory and whose
// sync mirrors VectorPngDocument.syncSource (pending + broadcast).
function fakeDocument(source) {
  return {
    history: new SourceHistory(source),
    pendingSource: source,
    savedSource: source,
    synced: [],
    syncSource(next) { this.pendingSource = next; this.synced.push(next); },
    undo() { const s = this.history.undo(); if (s !== undefined) this.syncSource(s); },
    redo() { const s = this.history.redo(); if (s !== undefined) this.syncSource(s); },
  };
}

test('success applies exactly one undoable edit and reports the summary including losses', async () => {
  const deps = { normalize: async () => ({ ok: true, output: NORMALIZED, summary: SUMMARY }) };
  const document = fakeDocument(ORIGINAL);
  const result = await normalizeSourceText(deps, document.pendingSource);
  assert.equal(result.status, 'normalized');
  assert.equal(result.source, NORMALIZED);
  assert.deepEqual(result.summary, SUMMARY);
  assert.equal(applyNormalizedEdit(document, result.source), true);
  assert.equal(document.pendingSource, NORMALIZED);
  assert.equal(document.history.isDirty(document.savedSource), true, 'the edit lands dirty');
  assert.equal(document.history.size, 2, 'exactly one history entry was added');
  document.undo();
  assert.equal(document.pendingSource, ORIGINAL, 'one undo restores the pre-normalization source');
  document.redo();
  assert.equal(document.pendingSource, NORMALIZED);
  const line = formatNormalizeSummary(result.summary);
  assert.match(line, /3 declaration\(s\) materialized/);
  assert.match(line, /1 marker\(s\) expanded/);
  assert.match(line, /aria-labelledby -> title/);
  assert.deepEqual(result.summary.losses, ['Accessibility: role "img" could not be preserved (unsupported-semantics)'],
    'recorded losses are part of the result, never dropped');
});

test('failure leaves the document untouched and surfaces the code', async () => {
  const deps = {
    normalize: async () => ({
      ok: false, code: 'unsupported-css', message: "Unsupported numeric syntax: '1em'",
      errors: ["unsupported-css (css): Unsupported numeric syntax: '1em'"],
    }),
  };
  const document = fakeDocument(ORIGINAL);
  const result = await normalizeSourceText(deps, document.pendingSource);
  assert.deepEqual(result, {
    status: 'failed', code: 'unsupported-css',
    message: "Unsupported numeric syntax: '1em'",
    errors: ["unsupported-css (css): Unsupported numeric syntax: '1em'"],
  });
  assert.equal(document.pendingSource, ORIGINAL);
  assert.equal(document.history.size, 1, 'no history entry');
  assert.equal(document.synced.length, 0, 'nothing was synced or applied');
});

test('an unreachable Core fails cleanly and changes nothing', async () => {
  const deps = { normalize: async () => { throw new ExportUnavailableError('no python'); } };
  const document = fakeDocument(ORIGINAL);
  const result = await normalizeSourceText(deps, document.pendingSource);
  assert.deepEqual(result, { status: 'failed', code: 'unavailable', message: 'no python', errors: [] });
  assert.equal(document.pendingSource, ORIGINAL);
  assert.equal(document.history.size, 1);
});

test('byte-identical output is already-normalized: no edit, no dirty state', async () => {
  const deps = { normalize: async () => ({ ok: true, output: ORIGINAL, summary: SUMMARY }) };
  const document = fakeDocument(ORIGINAL);
  const result = await normalizeSourceText(deps, document.pendingSource);
  assert.deepEqual(result, { status: 'already-normalized' });
  // The provider makes no edit for this status; even a defensive
  // application would be refused by the history as an identical edit.
  assert.equal(applyNormalizedEdit(document, ORIGINAL), false);
  assert.equal(document.history.size, 1);
  assert.equal(document.history.isDirty(document.savedSource), false);
});

test('summaryFromReport reads counts, migrations and losses from a conversion report', () => {
  const summary = summaryFromReport({
    changes: { applied_declarations: 2, expanded_markers: 0, style_elements: 1, class_attributes: 4, inline_styles: 1 },
    accessibility: [
      { attribute: 'aria-labelledby', value: 'title', target: 'title' },
      { attribute: 'role', value: 'img', loss: 'unsupported-semantics' },
    ],
    warnings: [{ code: 'accessibility-loss', stage: 'accessibility', explanation: 'Review recorded semantic losses' }],
  });
  assert.equal(summary.appliedDeclarations, 2);
  assert.equal(summary.classAttributes, 4);
  assert.deepEqual(summary.migrations, ['aria-labelledby -> title']);
  assert.deepEqual(summary.losses, ['Accessibility: role "img" could not be preserved (unsupported-semantics)']);
});

// Real-Core integration: set VECTOR_PNG_TEST_PYTHON to a Python with
// the Core importable. Skipped (not faked) when no Core is available.
const python = process.env.VECTOR_PNG_TEST_PYTHON;
const maybe = python ? test : test.skip;

maybe('real Core: styled source normalizes, and its output is a fixed point', async () => {
  const deps = createCoreNormalizeDeps(python);
  const first = await normalizeSourceText(deps, ORIGINAL);
  assert.equal(first.status, 'normalized', JSON.stringify(first));
  assert.ok(!first.source.includes('<style'), 'the style element is materialized away');
  assert.ok(first.summary.appliedDeclarations > 0);
  const second = await normalizeSourceText(deps, first.source);
  assert.deepEqual(second, { status: 'already-normalized' }, 'normalized output normalizes to itself byte-exactly');
});

maybe('real Core: a section 7 failure reports its code and errors', async () => {
  const deps = createCoreNormalizeDeps(python);
  const bad = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><style>.a {letter-spacing: 1em}</style><rect class="a" width="8" height="8"/></svg>';
  const result = await normalizeSourceText(deps, bad);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'unsupported-css');
  assert.ok(result.errors.some((line) => line.includes('unsupported-css')), JSON.stringify(result.errors));
});
