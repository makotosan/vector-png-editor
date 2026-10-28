import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadState() {
  const code = await readFile(new URL('../webview/preview-state.js', import.meta.url), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.VpePreviewState.createPreviewState();
}

test('starts on the saved raster; results never auto-toggle', async () => {
  const s = await loadState();
  assert.equal(s.mode, 'saved');
  assert.equal(s.visibleUri('saved.png'), 'saved.png');
  s.editedRendered('edited-1.png', 1);
  assert.equal(s.mode, 'saved', 'an arriving preview must not switch the mode');
  assert.equal(s.visibleUri('saved.png'), 'saved.png', 'saved mode always shows the actual saved raster');
});

test('manual toggle switches both ways and picks the latest edited render', async () => {
  const s = await loadState();
  s.editedRendered('edited-1.png', 1);
  s.showEdited();
  assert.equal(s.visibleUri('saved.png'), 'edited-1.png');
  s.editedRendered('edited-2.png', 2);
  assert.equal(s.visibleUri('saved.png'), 'edited-2.png', 'refresh within the chosen mode is not a toggle');
  s.showSaved();
  assert.equal(s.visibleUri('saved.png'), 'saved.png');
});

test('invalid edited source keeps the last valid render and records the error', async () => {
  const s = await loadState();
  s.editedRendered('edited-1.png', 1);
  s.editedInvalid('script is not allowed');
  assert.equal(s.editedError, 'script is not allowed');
  s.showEdited();
  assert.equal(s.visibleUri('saved.png'), 'edited-1.png', 'the unchecked source itself is never shown');
});
