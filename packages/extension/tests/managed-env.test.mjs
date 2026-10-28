import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickPython, managedPython, resolveCorePython, locateCoreArtifacts } from '../src/managedEnv.ts';

test('resolution precedence: explicit setting wins over the managed environment', () => {
  assert.equal(pickPython('/custom/python', '/managed/python'), '/custom/python');
  assert.equal(pickPython('  /custom/python  ', '/managed/python'), '/custom/python');
  assert.equal(pickPython('', '/managed/python'), '/managed/python');
  assert.equal(pickPython('   ', '/managed/python'), '/managed/python');
  assert.equal(pickPython(undefined, undefined), undefined);
});

test('an empty store resolves to no managed Python (and never throws)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-store-'));
  assert.equal(await managedPython(dir), undefined);
  assert.equal(await resolveCorePython(dir, undefined), undefined);
  assert.equal(await resolveCorePython(dir, '/set/python'), '/set/python');
});

test('a corrupt store fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-store-'));
  await writeFile(join(dir, 'active.json'), '{broken', 'utf8');
  assert.equal(await managedPython(dir), undefined);
});

test('the bundled requirements copy matches the canonical lock byte for byte', async () => {
  const bundled = await readFile(new URL('../managed/requirements.lock', import.meta.url));
  const canonical = await readFile(new URL('../../../requirements.lock', import.meta.url));
  assert.deepEqual(bundled, canonical);
});

test('artifact location: a sibling checkout wheel is found with its lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-artifacts- 空格 '));
  // Recreate the repo layout in a path with spaces and non-ASCII.
  const extDir = join(dir, 'packages', 'extension');
  const dist = join(dir, 'packages', 'core', 'dist');
  await mkdir(extDir, { recursive: true });
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'vector_png_editor_core-0.1.0.dev3-py3-none-any.whl'), 'fake-wheel-bytes');
  await writeFile(join(dir, 'requirements.lock'), 'Pillow==13.0.0\n');
  const artifacts = await locateCoreArtifacts({ extensionDir: extDir });
  assert.equal(artifacts.source, 'sibling checkout');
  assert.equal(artifacts.version, '0.1.0.dev3');
  assert.match(artifacts.wheelSha256, /^[0-9a-f]{64}$/);
  assert.equal(await locateCoreArtifacts({ extensionDir: join(dir, 'nowhere') }), undefined);
});
