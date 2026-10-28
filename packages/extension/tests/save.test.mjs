import test from 'node:test';
import assert from 'node:assert/strict';
import { saveInPlace, saveAs, SaveBlockedError, SaveConflictError, SaveCancelledError } from '../src/save.ts';

function fakeDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    sha256File: async () => 'a'.repeat(64),
    targetExists: async () => false,
    build: async (req) => { calls.push(req); return { ok: true, backup: '/x.backup' }; },
    ...overrides,
  };
}
const input = { source: '<svg/>', width: 8, height: 8 };

test('save in place overwrites under the current revision token', async () => {
  const deps = fakeDeps();
  const result = await saveInPlace(deps, '/doc.png', input);
  assert.equal(result.backup, '/x.backup');
  assert.equal(deps.calls.length, 1);
  const req = deps.calls[0];
  assert.equal(req.output, '/doc.png');
  assert.equal(req.overwrite, true);
  assert.equal(req.expectedSha256, 'a'.repeat(64));
  assert.equal(Buffer.from(req.sourceBase64, 'base64').toString('utf8'), '<svg/>');
});

test('profile violation blocks the save (no retry, typed error)', async () => {
  const deps = fakeDeps({ build: async () => ({ ok: false, code: 'unsupported-profile', message: 'script is not allowed' }) });
  await assert.rejects(saveInPlace(deps, '/doc.png', input), SaveBlockedError);
});

test('conflict is reported distinctly so the buffer can be preserved', async () => {
  const deps = fakeDeps({ build: async () => ({ ok: false, code: 'conflict', message: 'changed' }) });
  await assert.rejects(saveInPlace(deps, '/doc.png', input), SaveConflictError);
});

test('Save As to a new file builds without overwrite or token', async () => {
  const deps = fakeDeps();
  await saveAs(deps, '/new.png', input);
  assert.equal(deps.calls[0].overwrite, false);
  assert.equal(deps.calls[0].expectedSha256, undefined);
});

test('Save As over an existing file uses that file\u2019s token', async () => {
  const deps = fakeDeps({ targetExists: async () => true, sha256File: async () => 'b'.repeat(64) });
  await saveAs(deps, '/existing.png', input);
  assert.equal(deps.calls[0].overwrite, true);
  assert.equal(deps.calls[0].expectedSha256, 'b'.repeat(64));
});

test('cancellation before launch prevents any build', async () => {
  const deps = fakeDeps();
  await assert.rejects(saveInPlace(deps, '/doc.png', { ...input, isCancelled: () => true }), SaveCancelledError);
  assert.equal(deps.calls.length, 0);
});
