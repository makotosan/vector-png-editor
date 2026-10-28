import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSvgSaveDeps, saveSvgTextFile, SvgSaveConflictError } from '../src/svgSave.ts';

const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

test('saved bytes equal the edited source text exactly (BOM and CRLF preserved)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-svg-save-'));
  const path = join(dir, 'doc.svg');
  const original = '﻿<svg xmlns="http://www.w3.org/2000/svg">\r\n<rect fill="red"/>\r\n</svg>';
  await writeFile(path, original, 'utf8');
  const edited = original.replace('red', 'blue');
  const result = await saveSvgTextFile(createNodeSvgSaveDeps(), path, edited, await sha(path));
  assert.deepEqual(new Uint8Array(await readFile(path)), new TextEncoder().encode(edited));
  assert.equal(result.sha256, await sha(path), 'the returned token matches the written file');
});

test('a changed file refuses the write and keeps the external version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-svg-save-'));
  const path = join(dir, 'doc.svg');
  await writeFile(path, '<svg>v1</svg>', 'utf8');
  const agreed = await sha(path);
  await writeFile(path, '<svg>external</svg>', 'utf8');
  await assert.rejects(saveSvgTextFile(createNodeSvgSaveDeps(), path, '<svg>mine</svg>', agreed), SvgSaveConflictError);
  assert.equal(await readFile(path, 'utf8'), '<svg>external</svg>');
});

test('a missing file with a revision token is a conflict; without one it is created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-svg-save-'));
  const path = join(dir, 'doc.svg');
  await assert.rejects(
    saveSvgTextFile(createNodeSvgSaveDeps(), path, '<svg/>', 'a'.repeat(64)),
    SvgSaveConflictError);
  const result = await saveSvgTextFile(createNodeSvgSaveDeps(), path, '<svg/>', undefined);
  assert.equal(await readFile(path, 'utf8'), '<svg/>');
  assert.equal(result.sha256, await sha(path));
});
