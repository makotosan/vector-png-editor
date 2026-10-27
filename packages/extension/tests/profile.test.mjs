import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SAFE_SVG_ELEMENTS, SAFE_SVG_ATTRIBUTES } from '../src/profile.ts';

function parseCoreSet(text, name) {
  const m = text.match(new RegExp(`${name} = set\\("([^"]+)"\\.split\\(\\)\\)`));
  assert.ok(m, `${name} set not found in Core _backend.py`);
  return m[1].split(' ').sort();
}

test('profile lists match the Python Core allowlist exactly', async () => {
  const backend = await readFile(new URL('../../core/src/vector_png_editor/_backend.py', import.meta.url), 'utf8');
  assert.deepEqual([...SAFE_SVG_ELEMENTS].sort(), parseCoreSet(backend, 'TAGS'));
  assert.deepEqual([...SAFE_SVG_ATTRIBUTES].sort(), parseCoreSet(backend, 'ATTRS'));
});

test('profile excludes script, style, event handlers and links', () => {
  for (const banned of ['script', 'style', 'image', 'a', 'foreignObject', 'animate'])
    assert.ok(!SAFE_SVG_ELEMENTS.includes(banned), banned);
  for (const banned of ['style', 'href', 'xlink:href', 'onclick', 'onload', 'class'])
    assert.ok(!SAFE_SVG_ATTRIBUTES.includes(banned), banned);
});
