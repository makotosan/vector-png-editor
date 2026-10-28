import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSvgText, hasSvgRoot, isSvgFileName, parseSvgSize, svgDocumentSize } from '../src/svgSource.ts';

test('isSvgFileName matches .svg case-insensitively only at the end', () => {
  assert.equal(isSvgFileName('a.svg'), true);
  assert.equal(isSvgFileName('A.SVG'), true);
  assert.equal(isSvgFileName('a.svg.png'), false);
  assert.equal(isSvgFileName('a.png'), false);
});

test('decodeSvgText round-trips text and rejects binary and oversize input', () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  assert.equal(decodeSvgText(new TextEncoder().encode(text)), text);
  assert.equal(decodeSvgText(new Uint8Array([0xff, 0xfe, 0x00, 0x01])), null);
  assert.equal(decodeSvgText(new Uint8Array(1_000_001).fill(0x20)), null);
});

test('size comes from the root width/height attributes', () => {
  assert.deepEqual(
    parseSvgSize('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect/></svg>'),
    { width: 640, height: 480 });
  assert.deepEqual(
    parseSvgSize('<svg width="120px" height="90.4"></svg>'),
    { width: 120, height: 90 });
});

test('viewBox supplies the size when attributes are missing or non-absolute', () => {
  assert.deepEqual(parseSvgSize('<svg viewBox="0 0 300 150"></svg>'), { width: 300, height: 150 });
  assert.deepEqual(parseSvgSize('<svg width="100%" height="100%" viewBox="0 0 200 100"></svg>'), { width: 200, height: 100 });
  // A lone attribute is completed through the viewBox aspect ratio.
  assert.deepEqual(parseSvgSize('<svg width="400" viewBox="0 0 200 100"></svg>'), { width: 400, height: 200 });
});

test('a root without dimensions gets the default viewport; no root gets null', () => {
  assert.deepEqual(parseSvgSize('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { width: 1024, height: 1024 });
  assert.equal(parseSvgSize('<html><body/></html>'), null);
  assert.equal(parseSvgSize('not markup at all'), null);
  assert.deepEqual(svgDocumentSize('not markup at all'), { width: 1024, height: 1024 });
});

test('dimensions are clamped to the Core viewport limits', () => {
  const size = parseSvgSize('<svg width="100000" height="100000"></svg>');
  assert.ok(size.width <= 4096 && size.height <= 4096);
  assert.ok(size.width * size.height <= 4_000_000);
});

test('hasSvgRoot sees through prologs and comments-free prefixes', () => {
  assert.equal(hasSvgRoot('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), true);
  assert.equal(hasSvgRoot('<svgx/>'), false);
  assert.equal(hasSvgRoot(''), false);
});
