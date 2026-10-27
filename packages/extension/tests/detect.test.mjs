import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPng, SOURCE_KEYWORD } from '../src/detect.ts';
import { buildChunk, ihdrData } from '../src/png.ts';
import { assemble, ordinaryPng, vectorPng, itxt, idatFor } from './fixtures.mjs';

test('ordinary PNG is detected as ordinary', () => {
  assert.deepEqual(detectPng(ordinaryPng(3, 5)), { kind: 'ordinary-png', width: 3, height: 5 });
});

test('valid vector-png is detected without parsing the SVG', () => {
  // Even a payload that is not valid zlib/SVG routes as vector-png here:
  // detection is structural only; the Core validates content on open.
  assert.deepEqual(detectPng(vectorPng(7, 9)), { kind: 'vector-png', width: 7, height: 9 });
});

test('keyword in tEXt is corrupt, not ordinary', () => {
  const png = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt('<svg/>', { chunkType: 'tEXt', flag: 0 }), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  const result = detectPng(png);
  assert.equal(result.kind, 'corrupt-vector-png');
  assert.match(result.diagnostic, /iTXt/);
});

test('duplicate source chunks are corrupt', () => {
  const png = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt(), itxt(), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  assert.equal(detectPng(png).kind, 'corrupt-vector-png');
});

test('uncompressed iTXt source is corrupt', () => {
  const png = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt('<svg/>', { flag: 0, rawPayload: new TextEncoder().encode('<svg/>') }), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  assert.equal(detectPng(png).kind, 'corrupt-vector-png');
});

test('malformed keyword container with bad CRC is corrupt, not ordinary', () => {
  const png = vectorPng();
  const corrupted = Uint8Array.from(png);
  corrupted[corrupted.length - 1] ^= 0xff;
  const result = detectPng(corrupted);
  assert.equal(result.kind, 'corrupt-vector-png');
});

test('truncated PNG without the keyword is not-png', () => {
  const result = detectPng(ordinaryPng().subarray(0, 20));
  assert.equal(result.kind, 'not-png');
});

test('non-PNG bytes are not-png', () => {
  assert.equal(detectPng(new TextEncoder().encode('hello world, not an image')).kind, 'not-png');
});

test(`keyword constant matches the Core wire keyword`, () => {
  assert.equal(SOURCE_KEYWORD, 'vector-png.svg');
});
