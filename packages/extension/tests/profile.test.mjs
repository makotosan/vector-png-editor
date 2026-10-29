import test from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_SVG_ELEMENTS, SAFE_SVG_ATTRIBUTES } from '../src/profile.ts';
import { TAGS, ATTRS } from '../../ts-core/src/validate.ts';

test('profile lists match the TypeScript Core allowlist exactly', () => {
  assert.deepEqual([...SAFE_SVG_ELEMENTS].sort(), [...TAGS].sort());
  assert.deepEqual([...SAFE_SVG_ATTRIBUTES].sort(), [...ATTRS].sort());
});

test('profile excludes script, style, event handlers and links', () => {
  for (const banned of ['script', 'style', 'image', 'a', 'foreignObject', 'animate'])
    assert.ok(!SAFE_SVG_ELEMENTS.includes(banned), banned);
  for (const banned of ['style', 'href', 'xlink:href', 'onclick', 'onload', 'class'])
    assert.ok(!SAFE_SVG_ATTRIBUTES.includes(banned), banned);
});
