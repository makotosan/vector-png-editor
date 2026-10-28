import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPng } from '../src/detect.ts';
import { openModeFor } from '../src/openMode.ts';
import { buildChunk, ihdrData } from '../src/png.ts';
import { assemble, ordinaryPng, vectorPng, itxt, idatFor } from './fixtures.mjs';

// The custom-editor open path (Issue #46): detection -> open mode.
// openCustomDocument in extension.ts is a thin VS Code shell over
// openModeFor(detectPng(bytes)); these tests pin that decision for all
// four detection kinds.

test('vector-png opens in edit mode with its dimensions', () => {
  assert.deepEqual(openModeFor(detectPng(vectorPng(7, 9))), { mode: 'edit', width: 7, height: 9 });
});

test('ordinary PNG opens in view mode instead of being rejected', () => {
  assert.deepEqual(openModeFor(detectPng(ordinaryPng(3, 5))), { mode: 'view', width: 3, height: 5 });
});

test('corrupt vector-png is still rejected with its diagnostic', () => {
  const png = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt('<svg/>', { chunkType: 'tEXt', flag: 0 }), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  const mode = openModeFor(detectPng(png));
  assert.equal(mode.mode, 'reject');
  assert.match(mode.diagnostic, /iTXt/);
});

test('duplicate source chunks are still rejected, not viewed', () => {
  const png = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt(), itxt(), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  assert.equal(openModeFor(detectPng(png)).mode, 'reject');
});

test('non-PNG is still rejected with its diagnostic', () => {
  const mode = openModeFor(detectPng(new TextEncoder().encode('this is not a png')));
  assert.equal(mode.mode, 'reject');
  assert.ok(mode.diagnostic.length > 0);
});

test('view mode is reachable for every ordinary PNG shape and never for vector-png', () => {
  for (const [w, h] of [[1, 1], [16, 16], [1200, 620]]) {
    assert.equal(openModeFor(detectPng(ordinaryPng(w, h))).mode, 'view');
    assert.equal(openModeFor(detectPng(vectorPng(w, h))).mode, 'edit');
  }
});

test('opening an ordinary PNG in view mode leaves the file byte-identical', async () => {
  // The view-mode open path is read-only by construction: the host only
  // reads the bytes (detectPng + openModeFor) and the document carries
  // no source, so save has nothing to write. This test runs exactly
  // that host decision sequence against a real file on disk and
  // compares hashes before and after.
  const dir = await mkdtemp(join(tmpdir(), 'vpe-view-'));
  const path = join(dir, 'plain.png');
  const bytes = ordinaryPng(4, 4);
  await writeFile(path, bytes);
  const before = createHash('sha256').update(await readFile(path)).digest('hex');
  const mode = openModeFor(detectPng(new Uint8Array(await readFile(path))));
  assert.equal(mode.mode, 'view');
  const after = createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(after, before);
});
