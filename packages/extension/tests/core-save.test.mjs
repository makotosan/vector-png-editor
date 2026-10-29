import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreSaveDeps } from '../src/coreSave.ts';
import { buildToFile, createTsCoreRuntime } from '../src/tsCore.ts';
import { loadHostFonts } from '../src/hostFonts.ts';
import { saveInPlace, saveAs, SaveBlockedError, SaveConflictError } from '../src/save.ts';
import { extractSource } from '../src/extract.ts';

// Save integration against the TypeScript Core (Issue #58): the
// build runs in-process, so these run by default.
const runtime = createTsCoreRuntime({ fonts: loadHostFonts() });
const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

async function buildOriginal(dir, source) {
  const output = join(dir, 'doc.png');
  const outcome = await buildToFile(runtime, {
    sourceBase64: Buffer.from(source, 'utf8').toString('base64'),
    output, width: 8, height: 8, overwrite: false,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return output;
}

test('save preserves BOM/CRLF bytes exactly and updates the raster', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const original = '﻿<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">\r\n<rect width="8" height="8" fill="red"/>\r\n</svg>';
  const path = await buildOriginal(dir, original);
  const edited = original.replace('red', 'blue');
  const deps = createCoreSaveDeps(runtime);
  const result = await saveInPlace(deps, path, { source: edited, width: 8, height: 8 });
  assert.ok(result.backup, 'overwrite save retains a backup snapshot');
  await access(result.backup);
  const extracted = extractSource(await readFile(path));
  assert.equal(extracted.text, edited, 'edited source round-trips byte-exactly');
  assert.equal(extracted.newline, 'crlf');
  assert.equal(extracted.hasBom, true);
});

test('invalid source blocks the save and the original file is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const path = await buildOriginal(dir, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
  const before = await sha(path);
  const deps = createCoreSaveDeps(runtime);
  await assert.rejects(
    saveInPlace(deps, path, { source: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', width: 8, height: 8 }),
    SaveBlockedError);
  assert.equal(await sha(path), before, 'failed save retains the original bytes');
});

test('external change between token read and build is a conflict, external version wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const path = await buildOriginal(dir, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  const staleToken = await sha(path);
  // External writer replaces the file.
  const external = createCoreSaveDeps(runtime);
  await saveInPlace(external, path, { source: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>', width: 8, height: 8 });
  const externalSha = await sha(path);
  // Our save now presents the stale token.
  const deps = { ...createCoreSaveDeps(runtime), sha256File: async () => staleToken };
  await assert.rejects(
    saveInPlace(deps, path, { source: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>', width: 8, height: 8 }),
    SaveConflictError);
  assert.equal(await sha(path), externalSha, 'conflicting save never overwrites the external version');
});

test('Save As writes a new file and leaves the original alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-save-'));
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
  const path = await buildOriginal(dir, source);
  const before = await sha(path);
  const target = join(dir, 'copy.png');
  const deps = createCoreSaveDeps(runtime);
  await saveAs(deps, target, { source: source.replace('red', 'blue'), width: 8, height: 8 });
  assert.equal(extractSource(await readFile(target)).text.includes('blue'), true);
  assert.equal(await sha(path), before);
});
