import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalChangeTracker } from '../src/watch.ts';

test('own-save echo is ignored by content, not timing', () => {
  const t = new ExternalChangeTracker('sha-open');
  t.noteSaved('sha-v1');                       // our save published sha-v1
  assert.equal(t.observe('sha-v1', false), 'ignore');  // watcher echo arrives later
  assert.equal(t.observe('sha-v1', true), 'ignore');
  assert.equal(t.isConflicted, false);
});

test('external change on a clean document reloads and re-agrees', () => {
  const t = new ExternalChangeTracker('sha-open');
  assert.equal(t.observe('sha-external', false), 'reload');
  assert.equal(t.agreedSha, 'sha-external');
  assert.equal(t.observe('sha-external', false), 'ignore', 'the reload echo is not a second change');
});

test('external change on a dirty document conflicts and preserves the buffer', () => {
  const t = new ExternalChangeTracker('sha-open');
  assert.equal(t.observe('sha-external', true), 'conflict');
  assert.equal(t.isConflicted, true);
  assert.equal(t.agreedSha, 'sha-open', 'the agreed state never moves while conflicted');
  // More external edits while conflicted stay conflicted.
  assert.equal(t.observe('sha-external-2', true), 'conflict');
  // Explicit overwrite resolution clears the flag; the next save re-reads the token.
  t.resolveOverwrite();
  assert.equal(t.isConflicted, false);
  t.noteSaved('sha-mine');
  assert.equal(t.observe('sha-mine', false), 'ignore');
});

test('unreadable disk content conflicts even when clean (never reload unchecked)', () => {
  const t = new ExternalChangeTracker('sha-open');
  assert.equal(t.observeUnreadable(), 'conflict');
  assert.equal(t.isConflicted, true);
});

test('deletion: clean reports deleted once, dirty conflicts, recreation re-agrees', () => {
  const clean = new ExternalChangeTracker('sha-open');
  assert.equal(clean.observe(null, false), 'deleted');
  assert.equal(clean.observe(null, false), 'ignore');
  assert.equal(clean.isDeleted, true);

  const dirty = new ExternalChangeTracker('sha-open');
  assert.equal(dirty.observe(null, true), 'conflict');
  assert.equal(dirty.isDeleted, true);
  dirty.noteSaved('sha-recreated');            // save recreates the file
  assert.equal(dirty.isDeleted, false);
  assert.equal(dirty.observe('sha-recreated', false), 'ignore');
});

test('an external change that restores the agreed bytes clears a conflict', () => {
  const t = new ExternalChangeTracker('sha-open');
  assert.equal(t.observe('sha-other', true), 'conflict');
  assert.equal(t.observe('sha-open', true), 'ignore');
  assert.equal(t.isConflicted, false);
});
