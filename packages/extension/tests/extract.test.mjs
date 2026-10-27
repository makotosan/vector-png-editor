import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSource, ExtractError } from '../src/extract.ts';
import { vectorPng, ordinaryPng, assemble, itxt, idatFor } from './fixtures.mjs';
import { buildChunk, ihdrData } from '../src/png.ts';

test('extracts exact source bytes including BOM and CRLF', () => {
  const svg = '﻿<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">\r\n<rect width="2" height="2"/>\r\n</svg>';
  const png = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt(svg), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  const result = extractSource(png);
  assert.equal(result.text, svg);
  assert.equal(result.hasBom, true);
  assert.equal(result.newline, 'crlf');
});

test('plain LF source reports lf and no BOM', () => {
  const result = extractSource(vectorPng());
  assert.equal(result.hasBom, false);
  assert.ok(result.text.startsWith('<svg'));
});

test('ordinary PNG has no source to extract', () => {
  assert.throws(() => extractSource(ordinaryPng()), ExtractError);
});

test('decompression output is bounded', () => {
  const big = '<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(5000) + '</svg>';
  const png = assemble([buildChunk('IHDR', ihdrData(2, 2)), itxt(big), idatFor(2, 2), buildChunk('IEND', new Uint8Array(0))]);
  assert.throws(() => extractSource(png, 1024), /exceeds|not a valid/);
  assert.ok(extractSource(png, 100_000).text.length > 5000);
});
