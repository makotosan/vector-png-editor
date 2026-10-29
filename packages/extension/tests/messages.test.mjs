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

test('toolbar and panel action messages carry no fields and reject any', () => {
  for (const type of ['saveDocument', 'formatSource', 'copySource', 'exportSource', 'exportPng', 'normalizeSvg', 'exportAsVectorPng']) {
    assert.deepEqual(validateWebviewMessage({ type }), { ok: true, message: { type } });
    assert.equal(validateWebviewMessage({ type, path: '/tmp/x' }).ok, false, `${type} with a field`);
    assert.equal(validateWebviewMessage({ type, value: 'x' }).ok, false);
  }
});

test('applyRootFill accepts an exact shape and rejects everything else', () => {
  assert.deepEqual(validateWebviewMessage({ type: 'applyRootFill', value: '#ff0000' }),
    { ok: true, message: { type: 'applyRootFill', value: '#ff0000' } });
  assert.deepEqual(validateWebviewMessage({ type: 'applyRootFill', value: '' }),
    { ok: true, message: { type: 'applyRootFill', value: '' } }, 'empty clears the attribute');
  assert.deepEqual(validateWebviewMessage({ type: 'applyRootFill', value: 'url(#plate)' }),
    { ok: true, message: { type: 'applyRootFill', value: 'url(#plate)' } });
  for (const bad of [
    { type: 'applyRootFill' },
    { type: 'applyRootFill', value: 42 },
    { type: 'applyRootFill', value: '#fff', extra: true },
    { type: 'applyRootFill', value: 'x'.repeat(257) },
  ]) assert.equal(validateWebviewMessage(bad).ok, false, JSON.stringify(bad).slice(0, 60));
});
