import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFontFiles, fontDirectories, loadHostFonts } from '../src/hostFonts.ts';

// Host font selection (Issue #58): the interim strategy loads the
// common sans families from the platform font directories, chosen
// by file name, once per activation.

test('font directories are platform-shaped', () => {
  assert.ok(fontDirectories('linux', {}, '/home/u').includes('/usr/share/fonts'));
  assert.ok(fontDirectories('darwin', {}, '/Users/u').some((d) => d.includes('/System/Library/Fonts')));
  const win = fontDirectories('win32', { SystemRoot: 'C:\\Win', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u');
  assert.deepEqual(win[0], join('C:\\Win', 'Fonts'));
});

test('collectFontFiles claims rule-matched families in rule order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-fonts-'));
  const sub = join(dir, 'truetype', 'dejavu');
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, 'DejaVuSans.ttf'), 'x');
  await writeFile(join(dir, 'NotoSans-Bold.ttf'), 'x');
  await writeFile(join(dir, 'NotoSans-Regular.ttf'), 'x');
  await writeFile(join(dir, 'Random-Black.ttf'), 'x');
  await writeFile(join(dir, 'notes.txt'), 'x');
  const files = await collectFontFiles([dir]);
  assert.deepEqual(files.map((f) => f.family), ['Noto Sans', 'Noto Sans', 'DejaVu Sans']);
  assert.deepEqual(files.map((f) => f.weight), [400, 700, 400]);
});

test('collectFontFiles falls back to any font file when no rule matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-fonts-'));
  await writeFile(join(dir, 'SomeCustomFont.ttf'), 'x');
  const files = await collectFontFiles([dir]);
  assert.equal(files.length, 1);
  assert.equal(files[0].family, '');
});

test('missing directories are not an error', async () => {
  assert.deepEqual(await collectFontFiles(['/nonexistent-font-dir']), []);
});

test('loadHostFonts resolves a coherent set on this machine', async () => {
  const host = await loadHostFonts();
  assert.equal(host.fonts.length, host.files.length);
  assert.equal(typeof host.defaultFamily, 'string');
  assert.ok(host.defaultFamily.length > 0);
  if (host.fonts.length > 0) {
    assert.ok(host.fonts.every((f) => f.data.length > 0));
  }
});
