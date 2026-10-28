import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSvgSource } from '../src/formatSource.ts';

test('indents nested elements by depth and dedents closing tags', () => {
  const source = '<svg>\n<g>\n<rect width="8"/>\n</g>\n</svg>';
  assert.equal(formatSvgSource(source), '<svg>\n  <g>\n    <rect width="8"/>\n  </g>\n</svg>');
});

test('an already formatted document is returned unchanged', () => {
  const source = '<?xml version="1.0"?>\n<svg width="8" height="8">\n  <rect width="8" height="8" fill="red"/>\n</svg>\n';
  assert.equal(formatSvgSource(source), source);
});

test('formatting is idempotent', () => {
  const messy = '<svg>\n<g><rect width="1"/></g>\n   <g>\n<path d="M0 0"/>\n</g>\n</svg>';
  const once = formatSvgSource(messy);
  assert.equal(formatSvgSource(once), once);
});

test('single-line subtrees and text-bearing elements keep their lines intact', () => {
  const source = '<svg><g><rect width="1"/></g><desc>Hello</desc></svg>';
  assert.equal(formatSvgSource(source), source);
});

test('style and text content is never re-indented', () => {
  const source = [
    '<svg>',
    '<style>',
    '   .a { fill: red; }',
    '      .b { fill: blue; }',
    '</style>',
    '<text x="1" y="2">',
    '   spaced   text',
    '</text>',
    '</svg>',
  ].join('\n');
  const formatted = formatSvgSource(source);
  assert.equal(formatted, [
    '<svg>',
    '  <style>',
    '   .a { fill: red; }',
    '      .b { fill: blue; }',
    '</style>',
    '  <text x="1" y="2">',
    '   spaced   text',
    '</text>',
    '</svg>',
  ].join('\n'));
});

test('comments and CDATA sections pass through untouched and do not affect depth', () => {
  const source = [
    '<svg>',
    '<!-- a <g> in a comment',
    'still comment -->',
    '<rect width="1"/>',
    '</svg>',
  ].join('\n');
  assert.equal(formatSvgSource(source), [
    '<svg>',
    '  <!-- a <g> in a comment',
    'still comment -->',
    '  <rect width="1"/>',
    '</svg>',
  ].join('\n'));
});

test('a root tag spanning lines indents its continuation lines one level in', () => {
  const source = '<svg\nxmlns="http://www.w3.org/2000/svg"\nwidth="8">\n<rect width="8"/>\n</svg>';
  assert.equal(formatSvgSource(source),
    '<svg\n  xmlns="http://www.w3.org/2000/svg"\n  width="8">\n  <rect width="8"/>\n</svg>');
});

test('a greater-than inside an attribute value does not break tag scanning', () => {
  const source = '<svg data-note="a>b">\n<rect width="1"/>\n</svg>';
  assert.equal(formatSvgSource(source), '<svg data-note="a>b">\n  <rect width="1"/>\n</svg>');
});

test('blank lines stay blank and carry no indentation', () => {
  const source = '<svg>\n\n<rect width="1"/>\n\n</svg>';
  assert.equal(formatSvgSource(source), '<svg>\n\n  <rect width="1"/>\n\n</svg>');
});

test('text content lines of ordinary elements are indented as content, not structure', () => {
  const source = '<svg>\n<desc>\nSome words\n</desc>\n</svg>';
  assert.equal(formatSvgSource(source), '<svg>\n  <desc>\n    Some words\n  </desc>\n</svg>');
});
