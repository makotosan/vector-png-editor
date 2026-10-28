import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPlainPng, stripSourceChunk } from '../src/exportPng.ts';
import { ExportUnavailableError } from '../src/export.ts';
import { buildChunk, ihdrData } from '../src/png.ts';
import { detectPng } from '../src/detect.ts';
import { assemble, idatFor, itxt } from './fixtures.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>';
const vectorPng = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt(SVG), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
const plainPng = assemble([buildChunk('IHDR', ihdrData(2, 2)), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);

test('stripSourceChunk removes exactly the source chunk, byte-identical otherwise', () => {
  const stripped = stripSourceChunk(vectorPng);
  assert.equal(stripped.ok, true);
  assert.deepEqual(stripped.bytes, plainPng);
  assert.equal(detectPng(stripped.bytes).kind, 'ordinary-png');
  assert.equal(detectPng(vectorPng).kind, 'vector-png', 'the input itself is untouched');
});

test('stripSourceChunk refuses a PNG without a source chunk, with two, or not a PNG', () => {
  assert.equal(stripSourceChunk(plainPng).ok, false);
  const doubled = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt(SVG), itxt(SVG), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  assert.equal(stripSourceChunk(doubled).ok, false);
  assert.equal(stripSourceChunk(new Uint8Array([1, 2, 3])).ok, false);
});

function fakeDeps(overrides = {}) {
  const calls = { build: 0, convert: 0, choose: 0 };
  const written = new Map();
  const deps = {
    calls, written,
    validateProfile: async () => ({ valid: true }),
    renderViaBuild: async () => { calls.build++; return { ok: true, png: vectorPng, warnings: [] }; },
    renderViaConvert: async () => { calls.convert++; return { ok: true, png: vectorPng, warnings: ['converted warning'] }; },
    chooseTarget: async () => { calls.choose++; return '/work/out.png'; },
    writeFile: async (path, bytes) => { written.set(path, bytes); },
    ...overrides,
  };
  return deps;
}

const input = { source: SVG, width: 2, height: 2, defaultPath: '/work/doc.png' };

test('a valid source renders via build and writes the stripped plain PNG', async () => {
  const deps = fakeDeps();
  const result = await exportPlainPng(deps, input);
  assert.deepEqual(result, { status: 'exported', targetPath: '/work/out.png', viaNormalization: false, warnings: [] });
  assert.equal(deps.calls.build, 1);
  assert.equal(deps.calls.convert, 0);
  assert.deepEqual(deps.written.get('/work/out.png'), plainPng);
});

test('an invalid source renders via convert and reports the normalization route', async () => {
  const deps = fakeDeps({ validateProfile: async () => ({ valid: false, diagnostics: [] }) });
  const result = await exportPlainPng(deps, input);
  assert.equal(result.status, 'exported');
  assert.equal(result.viaNormalization, true);
  assert.deepEqual(result.warnings, ['converted warning']);
  assert.equal(deps.calls.build, 0);
  assert.equal(deps.calls.convert, 1);
  assert.deepEqual(deps.written.get('/work/out.png'), plainPng);
});

test('when the build route fails for a valid source, convert is the fallback', async () => {
  const deps = fakeDeps({
    renderViaBuild: async () => ({ ok: false, code: 'render-error', message: 'build broke' }),
  });
  const result = await exportPlainPng(deps, input);
  assert.equal(result.status, 'exported');
  assert.equal(result.viaNormalization, true);
  assert.equal(deps.calls.convert, 1);
});

test('when both routes fail, the primary route error is reported and nothing is written', async () => {
  const deps = fakeDeps({
    validateProfile: async () => ({ valid: false, diagnostics: [] }),
    renderViaBuild: async () => ({ ok: false, code: 'unsupported', message: 'build refuses' }),
    renderViaConvert: async () => ({ ok: false, code: 'unsupported-css', message: 'convert refuses' }),
  });
  const result = await exportPlainPng(deps, input);
  assert.deepEqual(result, { status: 'failed', stage: 'render', code: 'unsupported-css', message: 'convert refuses' });
  assert.equal(deps.calls.choose, 0);
  assert.equal(deps.written.size, 0);
});

test('a rendered PNG without a source chunk fails the strip step and writes nothing', async () => {
  const deps = fakeDeps({ renderViaBuild: async () => ({ ok: true, png: plainPng, warnings: [] }) });
  const result = await exportPlainPng(deps, input);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'strip');
  assert.equal(deps.calls.choose, 0);
  assert.equal(deps.written.size, 0);
});

test('cancelling the save dialog writes nothing', async () => {
  const deps = fakeDeps({ chooseTarget: async () => null });
  const result = await exportPlainPng(deps, input);
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(deps.written.size, 0);
});

test('an unreachable Core fails at the validate stage with its code', async () => {
  const deps = fakeDeps({
    validateProfile: async () => { throw new ExportUnavailableError('no python'); },
  });
  const result = await exportPlainPng(deps, input);
  assert.deepEqual(result, { status: 'failed', stage: 'validate', code: 'unavailable', message: 'no python' });
  assert.equal(deps.written.size, 0);
});
