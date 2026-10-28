import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceHistory } from '../src/history.ts';

test('basic undo/redo walks the recorded snapshots', () => {
  const h = new SourceHistory('a');
  assert.equal(h.current(), 'a');
  assert.equal(h.canUndo, false);
  h.recordEdit('ab', { now: 10 });
  h.recordEdit('abc', { now: 5000 });
  assert.equal(h.current(), 'abc');
  assert.equal(h.undo(), 'ab');
  assert.equal(h.undo(), 'a');
  assert.equal(h.undo(), undefined);
  assert.equal(h.redo(), 'ab');
  assert.equal(h.redo(), 'abc');
  assert.equal(h.redo(), undefined);
});

test('echoes and no-ops record nothing (feedback-loop guard)', () => {
  const h = new SourceHistory('x');
  assert.equal(h.recordEdit('x', { now: 1 }), false);
  assert.equal(h.size, 1);
  h.recordEdit('y', { now: 2 });
  // Host syncs 'y' back to the webview; the webview re-delivers 'y'.
  assert.equal(h.recordEdit('y', { now: 3 }), false);
  assert.equal(h.size, 2);
  assert.equal(h.undo(), 'x', 'one undo returns to the start: no duplicate entries');
});

test('a new edit after undo discards the redo tail', () => {
  const h = new SourceHistory('a');
  h.recordEdit('b', { now: 1 });
  h.recordEdit('c', { now: 2 });
  h.undo();
  h.recordEdit('d', { now: 3 });
  assert.equal(h.canRedo, false);
  assert.equal(h.current(), 'd');
  assert.equal(h.undo(), 'b');
});

test('typing bursts coalesce within the window, separate after it', () => {
  const h = new SourceHistory('');
  h.recordEdit('h', { now: 0, coalesceKey: 'typing' });
  h.recordEdit('he', { now: 200, coalesceKey: 'typing' });
  h.recordEdit('hel', { now: 400, coalesceKey: 'typing' });
  assert.equal(h.size, 2, 'the burst is one undoable entry');
  assert.equal(h.undo(), '');
  h.redo();
  h.recordEdit('hel!', { now: 5000, coalesceKey: 'typing' });
  assert.equal(h.size, 3);
  assert.equal(h.undo(), 'hel');
});

test('save does not clear history; dirtiness tracks the saved snapshot', () => {
  const h = new SourceHistory('v1');
  h.recordEdit('v2', { now: 1 });
  const saved = h.current(); // saveCustomDocument stores savedSource = 'v2'
  assert.equal(h.isDirty(saved), false);
  assert.equal(h.undo(), 'v1');
  assert.equal(h.isDirty(saved), true, 'undo across the save point is dirty again');
  assert.equal(h.redo(), 'v2');
  assert.equal(h.isDirty(saved), false);
});

test('replace-all is a single non-coalesced step', () => {
  const h = new SourceHistory('aaa');
  h.recordEdit('bbb', { now: 100 }); // no coalesce key: discrete edit
  h.recordEdit('ccc', { now: 150 });
  assert.equal(h.size, 3);
  assert.equal(h.undo(), 'bbb');
  assert.equal(h.undo(), 'aaa');
});

test('reset makes the restored snapshot the only state (revert/restore)', () => {
  const h = new SourceHistory('a');
  h.recordEdit('b', { now: 1 });
  h.recordEdit('c', { now: 2 });
  h.reset('disk');
  assert.equal(h.current(), 'disk');
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
});

test('history is bounded; oldest entries drop, current survives', () => {
  const h = new SourceHistory('0', { maxEntries: 3, coalesceMs: 0 });
  for (let i = 1; i <= 6; i++) h.recordEdit(String(i), { now: i * 10 });
  assert.ok(h.size <= 3);
  assert.equal(h.current(), '6');
  assert.equal(h.undo(), '5');
});
