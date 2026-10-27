import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { buildNewDocumentPng, NEW_DOCUMENT_SIZE, NEW_DOCUMENT_SVG } from '../src/newDocument.ts';
import { detectPng } from '../src/detect.ts';
import { walkChunks } from '../src/png.ts';

test('new document is a 1024x1024 vector-png', () => {
  const png = buildNewDocumentPng();
  assert.deepEqual(detectPng(png), { kind: 'vector-png', width: NEW_DOCUMENT_SIZE, height: NEW_DOCUMENT_SIZE });
});

test('new document raster is fully transparent and source matches the size', () => {
  const walk = walkChunks(buildNewDocumentPng());
  assert.equal(walk.ok, true);
  const idat = walk.chunks.filter(c => c.type === 'IDAT').map(c => c.data);
  const raw = inflateSync(Buffer.concat(idat.map(d => Buffer.from(d))));
  assert.equal(raw.length, NEW_DOCUMENT_SIZE * (1 + NEW_DOCUMENT_SIZE * 4));
  assert.ok(raw.every(b => b === 0), 'filter bytes and RGBA pixels are all zero (transparent)');
  const itxt = walk.chunks.find(c => c.type === 'iTXt');
  // Skip keyword, its terminator, flag/method and the two empty tag fields.
  const payloadStart = 'vector-png.svg'.length + 1 + 2 + 1 + 1;
  const svg = inflateSync(Buffer.from(itxt.data.subarray(payloadStart))).toString('utf8');
  assert.equal(svg, NEW_DOCUMENT_SVG);
});
