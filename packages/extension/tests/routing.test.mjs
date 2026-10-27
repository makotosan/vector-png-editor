import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFor } from '../src/routing.ts';

test('vector-png opens the custom editor', () => {
  assert.deepEqual(routeFor({ kind: 'vector-png', width: 1, height: 1 }, 'a.png'), { action: 'open-custom-editor' });
});

test('ordinary PNG falls back to the default viewer (no hijack)', () => {
  assert.deepEqual(routeFor({ kind: 'ordinary-png', width: 1, height: 1 }, 'a.png'), { action: 'open-default-viewer' });
});

test('corrupt vector-png shows a diagnostic instead of the default viewer', () => {
  const route = routeFor({ kind: 'corrupt-vector-png', diagnostic: 'duplicate source' }, 'a.png');
  assert.equal(route.action, 'show-diagnostic');
  assert.match(route.message, /a\.png/);
  assert.match(route.message, /duplicate source/);
});

test('non-PNG shows a diagnostic', () => {
  assert.equal(routeFor({ kind: 'not-png', diagnostic: 'bad signature' }, 'a.txt').action, 'show-diagnostic');
});
