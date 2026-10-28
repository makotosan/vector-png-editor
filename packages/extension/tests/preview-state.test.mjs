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

test('starts on the editing view; results never auto-toggle', async () => {
  const s = await loadState();
  assert.equal(s.mode, 'edited', 'the pane opens on Editing');
  assert.equal(s.visibleUri('saved.png'), null, 'no render has arrived yet');
  s.editedRendered('edited-1.png', 1);
  assert.equal(s.mode, 'edited');
  assert.equal(s.visibleUri('saved.png'), 'edited-1.png');
  s.showSaved();
  s.editedRendered('edited-2.png', 2);
  assert.equal(s.mode, 'saved', 'an arriving preview must not switch the mode');
  assert.equal(s.visibleUri('saved.png'), 'saved.png', 'the PNG mode always shows the raster the file holds');
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

test('background starts on the checkerboard preset with no custom colour', async () => {
  const s = await loadState();
  assert.equal(s.backgroundPreset, 'checkerboard');
  assert.equal(s.customColor, null);
  assert.equal(s.backgroundValue(), 'checkerboard');
});

test('presets map to their colours and an unknown preset is ignored', async () => {
  const s = await loadState();
  s.setBackgroundPreset('white');
  assert.equal(s.backgroundValue(), '#ffffff');
  s.setBackgroundPreset('black');
  assert.equal(s.backgroundValue(), '#000000');
  s.setBackgroundPreset('polka-dot');
  assert.equal(s.backgroundPreset, 'black', 'unknown presets do not move the state');
});

test('a custom colour deselects the presets and a preset clears the custom colour', async () => {
  const s = await loadState();
  s.setBackgroundPreset('white');
  s.setBackgroundCustom('#F00');
  assert.equal(s.customColor, '#ff0000', 'the colour is normalized on the way in');
  assert.equal(s.backgroundValue(), '#ff0000', 'the custom colour wins over the preset');
  s.setBackgroundPreset('black');
  assert.equal(s.customColor, null);
  assert.equal(s.backgroundValue(), '#000000');
});

test('an invalid custom colour is refused and the state is untouched', async () => {
  const s = await loadState();
  s.setBackgroundCustom('#00ff00');
  assert.equal(s.setBackgroundCustom('not-a-colour'), '#00ff00');
  assert.equal(s.customColor, '#00ff00');
  assert.equal(s.setBackgroundCustom('#12'), '#00ff00');
});

test('normalizeHexColor accepts #rgb and #rrggbb and rejects the rest', async () => {
  const code = await readFile(new URL('../webview/preview-state.js', import.meta.url), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  const normalize = sandbox.window.VpePreviewState.normalizeHexColor;
  assert.equal(normalize('#fff'), '#ffffff');
  assert.equal(normalize('#F7F7F7'), '#f7f7f7');
  assert.equal(normalize(' #0e639c '), '#0e639c');
  for (const bad of ['', 'fff', '#ffff', '#12345', 'red', 'url(#x)', '#gggggg', null, 42])
    assert.equal(normalize(bad), null, JSON.stringify(bad));
});
