// Third-party notices guard: the repository-root
// THIRD_PARTY_NOTICES.md must carry the resvg entry at the version
// pinned in this package's package.json (the successor of the
// retired Python suite's test_notices.py, narrowed to the one
// runtime dependency the product still has).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('root THIRD_PARTY_NOTICES names @resvg/resvg-wasm at the pinned version under MPL-2.0', async () => {
  const pkg = JSON.parse(
    await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  const pinned = pkg.dependencies['@resvg/resvg-wasm'];
  assert.ok(pinned, 'package.json must pin @resvg/resvg-wasm');
  const notices = await readFile(
    fileURLToPath(new URL('../../../THIRD_PARTY_NOTICES.md', import.meta.url)),
    'utf8',
  );
  assert.ok(notices.includes('@resvg/resvg-wasm'), 'notices must name @resvg/resvg-wasm');
  assert.ok(notices.includes(pinned), `notices must name the pinned version ${pinned}`);
  assert.ok(notices.includes('MPL-2.0'), 'notices must state the MPL-2.0 license');
  assert.ok(notices.includes('index_bg.wasm'), 'notices must carry the wasm bundling note');
});
