import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreSaveDeps } from '../src/coreSave.ts';
import { saveInPlace, saveAs, SaveBlockedError, SaveConflictError } from '../src/save.ts';
import { extractSource } from '../src/extract.ts';
import { runCore } from '../../bridge/src/core.ts';

// Real-Core integration: set VECTOR_PNG_TEST_PYTHON to a Python with the
// Core installed. Skipped (not faked) when no Core is available.
const python = process.env.VECTOR_PNG_TEST_PYTHON;
const maybe = python ? test : test.skip;

const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

async function buildOriginal(dir, source) {
  const output = join(dir, 'doc.png');
  const { response } = await runCore(python, {
    protocol: 1, command: 'build', request_id: 'it-original',
    source_base64: Buffer.from(source, 'utf8').toString('base64'),
    output, width: 8, height: 8, overwrite: false,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return output;
}

maybe('save preserves BOM/CRLF bytes exactly and updates the raster', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const original = '﻿<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">\r\n<rect width="8" height="8" fill="red"/>\r\n</svg>';
  const path = await buildOriginal(dir, original);
  const edited = original.replace('red', 'blue');
  const deps = createCoreSaveDeps(python);
  const result = await saveInPlace(deps, path, { source: edited, width: 8, height: 8 });
  assert.ok(result.backup, 'overwrite save retains a backup snapshot');
  await access(result.backup);
  const extracted = extractSource(await readFile(path));
  assert.equal(extracted.text, edited, 'edited source round-trips byte-exactly');
  assert.equal(extracted.newline, 'crlf');
  assert.equal(extracted.hasBom, true);
});

maybe('invalid source blocks the save and the original file is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const path = await buildOriginal(dir, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
  const before = await sha(path);
  const deps = createCoreSaveDeps(python);
  await assert.rejects(
    saveInPlace(deps, path, { source: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', width: 8, height: 8 }),
    SaveBlockedError);
  assert.equal(await sha(path), before, 'failed save retains the original bytes');
});

maybe('external change between token read and build is a conflict, external version wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const path = await buildOriginal(dir, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  const staleToken = await sha(path);
  // External writer replaces the file.
  const external = createCoreSaveDeps(python);
  await saveInPlace(external, path, { source: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>', width: 8, height: 8 });
  const externalSha = await sha(path);
  // Our save now presents the stale token.
  const deps = { ...createCoreSaveDeps(python), sha256File: async () => staleToken };
  await assert.rejects(
    saveInPlace(deps, path, { source: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>', width: 8, height: 8 }),
    SaveConflictError);
  assert.equal(await sha(path), externalSha, 'conflicting save never overwrites the external version');
});

maybe('Save As writes a new file and leaves the original alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
  const path = await buildOriginal(dir, source);
  const before = await sha(path);
  const target = join(dir, 'copy.png');
  const deps = createCoreSaveDeps(python);
  await saveAs(deps, target, { source: source.replace('red', 'blue'), width: 8, height: 8 });
  assert.equal(extractSource(await readFile(target)).text.includes('blue'), true);
  assert.equal(await sha(path), before);
});
