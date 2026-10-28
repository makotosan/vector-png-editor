import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSchemaProfile, childrenFor } from '../src/profileData.ts';
import { SAFE_SVG_ELEMENTS, SAFE_SVG_ATTRIBUTES } from '../src/profile.ts';

const canonical = new URL('../../../schemas/safe-svg-v1.monaco.json', import.meta.url);

test('generated monaco metadata parses and matches the mirrored profile', async () => {
  const profile = parseSchemaProfile(await readFile(canonical, 'utf8'));
  assert.equal(profile.profile, 'safe-svg-v1');
  assert.ok(profile.version.length > 0);
  assert.deepEqual([...profile.elements].sort(), [...SAFE_SVG_ELEMENTS].sort());
  assert.deepEqual([...profile.attributes].sort(), [...SAFE_SVG_ATTRIBUTES].sort());
});

test('content models drive child completion (Issue #22 Phase 2)', async () => {
  const profile = parseSchemaProfile(await readFile(canonical, 'utf8'));
  assert.deepEqual(childrenFor(profile, 'linearGradient').sort(), ['desc', 'stop', 'title']);
  assert.deepEqual(childrenFor(profile, 'text'), ['tspan']);
  assert.deepEqual(childrenFor(profile, 'stop'), []);
  assert.ok(childrenFor(profile, 'g').includes('rect'));
  assert.ok(!childrenFor(profile, 'g').includes('stop'), 'stop is gradient-only');
  assert.deepEqual(childrenFor(profile, null), profile.elements);
  assert.deepEqual([...profile.textElements].sort(), ['desc', 'text', 'title', 'tspan']);
});

test('foreign or malformed profiles are rejected, not guessed', async () => {
  assert.throws(() => parseSchemaProfile('{"profile":"other","version":"1","elements":[{"name":"svg","children":[]}],"attributes":[]}'));
  assert.throws(() => parseSchemaProfile('{"profile":"safe-svg-v1","version":"1","elements":[{"name":"svg","children":["nope"]}],"attributes":[]}'));
  assert.throws(() => parseSchemaProfile('not json'));
});
