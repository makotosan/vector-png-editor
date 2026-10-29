import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToFile, buildVectorPngBytes, createTsCoreRuntime } from '../src/tsCore.ts';
import { loadHostFonts } from '../src/hostFonts.ts';
import { extractSource } from '../src/extract.ts';

// The in-process build/publish path (Issue #58) mirrors the Python
// Core's writing.py discipline: token-guarded overwrite with a
// backup snapshot, create-without-clobber, lock and symlink
// refusals, and the Core's own error codes.
const runtime = createTsCoreRuntime({ fonts: loadHostFonts() });
const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const SRC = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`;
const build = (output, source, extra = {}) => buildToFile(runtime, {
  sourceBase64: Buffer.from(source, 'utf8').toString('base64'),
  output, width: 8, height: 8, overwrite: false, ...extra,
});

test('build creates a vector-png whose source round-trips byte-exactly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-tscore-'));
  const output = join(dir, 'doc.png');
  const outcome = await build(output, SRC('red'));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.backup, null, 'a fresh create retains no backup');
  assert.equal(extractSource(await readFile(output)).text, SRC('red'));
});

test('create over an existing file is output-exists and changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-tscore-'));
  const output = join(dir, 'doc.png');
  await build(output, SRC('red'));
  const before = await sha(output);
  const outcome = await build(output, SRC('blue'));
  assert.deepEqual(outcome, { ok: false, code: 'output-exists', message: 'Output already exists' });
  assert.equal(await sha(output), before);
});

test('overwrite requires the current token, then succeeds and keeps a backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-tscore-'));
  const output = join(dir, 'doc.png');
  await build(output, SRC('red'));
  const token = await sha(output);
  const stale = await build(output, SRC('blue'), { overwrite: true, expectedSha256: '0'.repeat(64) });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'conflict');
  const noToken = await buildToFile(runtime, {
    sourceBase64: Buffer.from(SRC('blue'), 'utf8').toString('base64'),
    output, width: 8, height: 8, overwrite: true,
  });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.code, 'invalid-arguments');
  const outcome = await build(output, SRC('blue'), { overwrite: true, expectedSha256: token });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(outcome.backup, 'overwrite retains a backup snapshot');
  assert.equal(extractSource(await readFile(outcome.backup)).text, SRC('red'), 'the backup holds the previous version');
  assert.equal(extractSource(await readFile(output)).text, SRC('blue'));
});

test('saving through a symlink is a conflict and the target is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-tscore-'));
  const real = join(dir, 'real.png');
  const linkPath = join(dir, 'link.png');
  await build(real, SRC('red'));
  await symlink(real, linkPath);
  const before = await sha(real);
  const outcome = await build(linkPath, SRC('blue'), { overwrite: true, expectedSha256: before });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'conflict');
  assert.equal(await sha(real), before);
});

test('a held output lock is a conflict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-tscore-'));
  const output = join(dir, 'doc.png');
  await writeFile(`${output}.vector-png.lock`, '');
  const outcome = await build(output, SRC('red'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'conflict');
  await access(`${output}.vector-png.lock`); // the foreign lock is not ours to remove
});

test('a profile-invalid source fails the build and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-tscore-'));
  const output = join(dir, 'doc.png');
  const outcome = await build(output, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'unsupported-profile');
  await assert.rejects(access(output));
});

test('buildVectorPngBytes rejects a source whose viewport aspect differs', async () => {
  // resvg scales uniformly; a non-document viewport is refused
  // rather than stretched (documented ts-core constraint).
  await assert.rejects(
    buildVectorPngBytes(runtime, Buffer.from(SRC('red'), 'utf8'), 8, 4),
    (error) => error.code === 'render-failed');
});
