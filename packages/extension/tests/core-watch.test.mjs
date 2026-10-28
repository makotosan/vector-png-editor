import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreSaveDeps } from '../src/coreSave.ts';
import { saveInPlace } from '../src/save.ts';
import { ExternalChangeTracker } from '../src/watch.ts';
import { runCore } from '../../bridge/src/core.ts';

// Real-Core integration with the Core CLI acting as the external
// editor: set VECTOR_PNG_TEST_PYTHON to a Python with the Core
// installed. Skipped (not faked) when no Core is available.
const python = process.env.VECTOR_PNG_TEST_PYTHON;
const maybe = python ? test : test.skip;
const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const src = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`;

async function externalEdit(path, fill) {
  const { response } = await runCore(python, {
    protocol: 1, command: 'build', request_id: `ext-${fill}`,
    source_base64: Buffer.from(src(fill), 'utf8').toString('base64'),
    output: path, width: 8, height: 8, overwrite: true, expected_sha256: await sha(path),
  });
  assert.equal(response.ok, true, JSON.stringify(response));
}

maybe('dirty buffer survives an external CLI edit; explicit overwrite then saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-watch-'));
  const path = join(dir, 'doc.png');
  const deps = createCoreSaveDeps(python);
  await saveInPlace(deps, path, { source: src('red'), width: 8, height: 8 }).catch(async () => {
    // First creation has no file to token-read; build directly instead.
    const { response } = await runCore(python, { protocol: 1, command: 'build', request_id: 'create', source_base64: Buffer.from(src('red'), 'utf8').toString('base64'), output: path, width: 8, height: 8, overwrite: false });
    assert.equal(response.ok, true);
  });
  const tracker = new ExternalChangeTracker(await sha(path));
  await externalEdit(path, 'green');                       // CLI edits the file
  assert.equal(tracker.observe(await sha(path), true), 'conflict'); // we are dirty
  tracker.resolveOverwrite();                              // user chooses ours
  await saveInPlace(deps, path, { source: src('blue'), width: 8, height: 8 });
  tracker.noteSaved(await sha(path));
  assert.equal(tracker.observe(await sha(path), false), 'ignore', 'own save echo ignored');
});

maybe('clean document reloads after an external CLI edit; deletion is observed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-watch-'));
  const path = join(dir, 'doc.png');
  const { response } = await runCore(python, { protocol: 1, command: 'build', request_id: 'create2', source_base64: Buffer.from(src('red'), 'utf8').toString('base64'), output: path, width: 8, height: 8, overwrite: false });
  assert.equal(response.ok, true);
  const tracker = new ExternalChangeTracker(await sha(path));
  await externalEdit(path, 'green');
  assert.equal(tracker.observe(await sha(path), false), 'reload');
  await rm(path);
  assert.equal(tracker.observe(null, false), 'deleted');
});
