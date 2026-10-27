import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebviewMessage } from '../src/messages.ts';
import { MAX_SVG_BYTES } from '../src/profile.ts';

test('ready is accepted', () => {
  assert.deepEqual(validateWebviewMessage({ type: 'ready' }), { ok: true, message: { type: 'ready' } });
});

test('well-formed sourceChanged is accepted', () => {
  const v = validateWebviewMessage({ type: 'sourceChanged', revision: 3, source: '<svg/>' });
  assert.equal(v.ok, true);
});

test('unknown and malformed messages are rejected', () => {
  for (const bad of [null, 42, 'x', [], {}, { type: 'eval' }, { type: 'ready', extra: 1 },
    { type: 'sourceChanged', revision: -1, source: '' },
    { type: 'sourceChanged', revision: 1.5, source: '' },
    { type: 'sourceChanged', revision: 0 },
    { type: 'sourceChanged', revision: 0, source: 42 }]) {
    assert.equal(validateWebviewMessage(bad).ok, false, JSON.stringify(bad));
  }
});

test('oversized source is rejected', () => {
  const v = validateWebviewMessage({ type: 'sourceChanged', revision: 0, source: 'x'.repeat(MAX_SVG_BYTES + 1) });
  assert.equal(v.ok, false);
});

test('oversized serialized message is rejected before parsing fields', () => {
  assert.equal(validateWebviewMessage({ type: 'ready' }, MAX_SVG_BYTES + 5000).ok, false);
});
