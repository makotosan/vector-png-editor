import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreSaveDeps } from '../src/coreSave.ts';
import { buildToFile, createTsCoreRuntime } from '../src/tsCore.ts';
import { loadHostFonts } from '../src/hostFonts.ts';
import { saveInPlace } from '../src/save.ts';
import { ExternalChangeTracker } from '../src/watch.ts';

// External-change integration (Issue #58): another writer - here
// the same production build an external tool performs, now the
// TypeScript Core's - edits the file on disk while the tracker
// observes. Runs by default; no Python is involved.
const runtime = createTsCoreRuntime({ fonts: loadHostFonts() });
const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const src = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`;

async function buildFile(path, fill, overwrite, expectedSha256) {
  const outcome = await buildToFile(runtime, {
    sourceBase64: Buffer.from(src(fill), 'utf8').toString('base64'),
    output: path, width: 8, height: 8, overwrite, expectedSha256,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
}

async function externalEdit(path, fill) {
  await buildFile(path, fill, true, await sha(path));
}

test('dirty buffer survives an external edit; explicit overwrite then saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-watch-'));
  const path = join(dir, 'doc.png');
  const deps = createCoreSaveDeps(runtime);
  await buildFile(path, 'red', false, undefined);
  const tracker = new ExternalChangeTracker(await sha(path));
  await externalEdit(path, 'green');                       // another writer edits the file
  assert.equal(tracker.observe(await sha(path), true), 'conflict'); // we are dirty
  tracker.resolveOverwrite();                              // user chooses ours
  await saveInPlace(deps, path, { source: src('blue'), width: 8, height: 8 });
  tracker.noteSaved(await sha(path));
  assert.equal(tracker.observe(await sha(path), false), 'ignore', 'own save echo ignored');
});

test('clean document reloads after an external edit; deletion is observed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-watch-'));
  const path = join(dir, 'doc.png');
  await buildFile(path, 'red', false, undefined);
  const tracker = new ExternalChangeTracker(await sha(path));
  await externalEdit(path, 'green');
  assert.equal(tracker.observe(await sha(path), false), 'reload');
  await rm(path);
  assert.equal(tracker.observe(null, false), 'deleted');
});
