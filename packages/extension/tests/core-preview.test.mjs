import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorePreviewRenderer } from '../src/corePreview.ts';
import { PreviewInvalidError, PreviewUnavailableError } from '../src/preview.ts';

// Real-Core integration: set VECTOR_PNG_TEST_PYTHON to a Python with the
// Core installed. Skipped (not faked) when no Core is available.
const python = process.env.VECTOR_PNG_TEST_PYTHON;
const maybe = python ? test : test.skip;

maybe('Core renders a valid edited source to a real PNG', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-preview-'));
  const render = createCorePreviewRenderer({ pythonPath: python, previewDir: dir, width: 8, height: 8, documentKey: 'testdoc' });
  const out = await render('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>', 1);
  const bytes = await readFile(out);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.readUInt32BE(16), 8);
  assert.equal(bytes.readUInt32BE(20), 8);
});

maybe('hostile source is rejected by Core validation and never rendered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-preview-'));
  const render = createCorePreviewRenderer({ pythonPath: python, previewDir: dir, width: 8, height: 8, documentKey: 'testdoc' });
  await assert.rejects(
    render('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 1),
    PreviewInvalidError);
});

test('without a configured Python the renderer reports unavailable', async () => {
  const render = createCorePreviewRenderer({ pythonPath: undefined, previewDir: '/tmp', width: 8, height: 8, documentKey: 'x' });
  await assert.rejects(render('<svg/>', 1), PreviewUnavailableError);
});
