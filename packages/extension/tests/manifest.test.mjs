import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

test('custom editor registers *.png and *.svg with priority option (Issue #47)', () => {
  const editors = manifest.contributes.customEditors;
  assert.equal(editors.length, 1);
  assert.equal(editors[0].viewType, 'vectorPng.editor');
  assert.equal(editors[0].priority, 'option');
  const patterns = editors[0].selector.map((s) => s.filenamePattern);
  assert.deepEqual(patterns, ['*.png', '*.svg']);
});

test('export command is contributed, activated and menu-bound for SVG files', () => {
  const commands = manifest.contributes.commands.map((c) => c.command);
  assert.ok(commands.includes('vectorPng.exportAsVectorPng'));
  assert.ok(manifest.activationEvents.includes('onCommand:vectorPng.exportAsVectorPng'));
  const explorer = manifest.contributes.menus['explorer/context'];
  const open = explorer.find((m) => m.command === 'vectorPng.openInEditor');
  assert.match(open.when, /\.svg/);
  const exp = explorer.find((m) => m.command === 'vectorPng.exportAsVectorPng');
  assert.ok(exp, 'export appears in the explorer context menu');
  assert.match(exp.when, /resourceExtname == \.svg/);
  const palette = manifest.contributes.menus.commandPalette.map((m) => m.command);
  assert.ok(palette.includes('vectorPng.exportAsVectorPng'));
});

test('normalize command is contributed and gated on SVG documents', () => {
  const commands = manifest.contributes.commands.map((c) => c.command);
  assert.ok(commands.includes('vectorPng.normalizeSvg'));
  assert.ok(manifest.activationEvents.includes('onCommand:vectorPng.normalizeSvg'));
  const explorer = manifest.contributes.menus['explorer/context'];
  assert.ok(explorer.some((m) => m.command === 'vectorPng.normalizeSvg' && /\.svg/.test(m.when)));
  const editor = manifest.contributes.menus['editor/context'];
  const entry = editor.find((m) => m.command === 'vectorPng.normalizeSvg');
  assert.ok(entry, 'normalize appears in the editor context menu');
  assert.match(entry.when, /vectorPng\.documentIsSvg/, 'editor entry is gated on the SVG document kind');
  const palette = manifest.contributes.menus.commandPalette.find((m) => m.command === 'vectorPng.normalizeSvg');
  assert.match(palette.when, /vectorPng\.documentIsSvg/);
});
