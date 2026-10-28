import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidFillValue, readRootFill, setRootFill } from '../src/rootFill.ts';

const DOC = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

test('reads a colour fill from the root element', () => {
  assert.deepEqual(readRootFill('<svg fill="#363636" width="8"></svg>'), { available: true, value: '#363636' });
});

test('reads a url(#id) fill and single-quoted values verbatim', () => {
  assert.deepEqual(readRootFill("<svg fill='url(#plate)'></svg>"), { available: true, value: 'url(#plate)' });
  assert.deepEqual(readRootFill('<svg fill="url(#a)"></svg>'), { available: true, value: 'url(#a)' });
});

test('an absent fill reads as the empty value, available', () => {
  assert.deepEqual(readRootFill(DOC), { available: true, value: '' });
});

test('reads the fill after an XML prolog, comments and a DOCTYPE', () => {
  const source = '<?xml version="1.0"?>\n<!-- note -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://example/dtd">\n<svg fill="red"></svg>';
  assert.deepEqual(readRootFill(source), { available: true, value: 'red' });
});

test('a nested element named svg is not the root; a non-svg root is unavailable', () => {
  assert.deepEqual(readRootFill('<html><svg fill="red"/></html>'), { available: false, value: '' });
  assert.deepEqual(readRootFill('not xml at all'), { available: false, value: '' });
  assert.deepEqual(readRootFill('<svg fill="unterminated></svg>'), { available: false, value: '' });
  assert.deepEqual(readRootFill('<svg fill></svg>'), { available: false, value: '' });
});

test('sets a fill on a root without one, appended after the last attribute', () => {
  assert.equal(
    setRootFill(DOC, '#123456'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" fill="#123456"><rect width="8" height="8"/></svg>');
});

test('sets a fill on a self-closing root and on a bare root', () => {
  assert.equal(setRootFill('<svg width="8"/>', 'red'), '<svg width="8" fill="red"/>');
  assert.equal(setRootFill('<svg/>', 'red'), '<svg fill="red"/>');
  assert.equal(setRootFill('<svg>', 'red'), '<svg fill="red">');
});

test('replaces an existing fill, preserving its quote style and every other byte', () => {
  const source = "<svg width='8' fill='red' height='9'><rect fill='blue'/></svg>";
  assert.equal(setRootFill(source, 'url(#plate)'), "<svg width='8' fill='url(#plate)' height='9'><rect fill='blue'/></svg>");
  assert.equal(
    setRootFill('<svg fill="red" width="8"></svg>', '#00ff00'),
    '<svg fill="#00ff00" width="8"></svg>');
});

test('applying the value already present is a byte-identical no-op', () => {
  const source = "<svg fill='red' width=\"8\"></svg>";
  assert.equal(setRootFill(source, 'red'), source);
  assert.equal(setRootFill(source, '  red  '), source, 'the field value is trimmed before applying');
});

test('an empty value removes the attribute and one separating space', () => {
  assert.equal(setRootFill('<svg width="8" fill="red" height="9"></svg>', ''), '<svg width="8" height="9"></svg>');
  assert.equal(setRootFill('<svg fill="red" width="8"></svg>', ''), '<svg width="8"></svg>');
  assert.equal(setRootFill('<svg fill="red"></svg>', '   '), '<svg></svg>');
  assert.equal(setRootFill('<svg width="8"></svg>', ''), '<svg width="8"></svg>', 'removing an absent fill changes nothing');
});

test('only the root start-tag is rewritten: child fills and text survive byte-for-byte', () => {
  const source = '<svg width="8"><rect fill="red"/><text fill="blue">fill="green"</text></svg>';
  assert.equal(
    setRootFill(source, '#000000'),
    '<svg width="8" fill="#000000"><rect fill="red"/><text fill="blue">fill="green"</text></svg>');
});

test('a root tag spanning lines keeps its layout; the fill lands before the close', () => {
  const source = '<svg\n  xmlns="http://www.w3.org/2000/svg"\n  width="8">\n</svg>';
  assert.equal(
    setRootFill(source, 'red'),
    '<svg\n  xmlns="http://www.w3.org/2000/svg"\n  width="8" fill="red">\n</svg>');
});

test('a greater-than inside another attribute value does not end the tag early', () => {
  const source = '<svg data-note="a>b" width="8"></svg>';
  assert.deepEqual(readRootFill(source), { available: true, value: '' });
  assert.equal(setRootFill(source, 'red'), '<svg data-note="a>b" width="8" fill="red"></svg>');
});

test('malformed roots reject writes as well as reads', () => {
  assert.equal(setRootFill('<svg fill></svg>', 'red'), null);
  assert.equal(setRootFill('<svg fill=red></svg>', 'blue'), null);
  assert.equal(setRootFill('<html></html>', 'red'), null);
  assert.equal(setRootFill('', 'red'), null);
});

test('fill values that cannot appear in an XML attribute are invalid', () => {
  assert.equal(isValidFillValue('#fff'), true);
  assert.equal(isValidFillValue('url(#plate)'), true);
  assert.equal(isValidFillValue('none'), true);
  assert.equal(isValidFillValue(''), true);
  assert.equal(isValidFillValue('a<b'), false);
  assert.equal(isValidFillValue('a>b'), false);
  assert.equal(isValidFillValue('a&b'), false);
  assert.equal(isValidFillValue('ab'), false);
  assert.equal(isValidFillValue('x'.repeat(257)), false);
  assert.equal(setRootFill(DOC, 'a<b'), null);
});
