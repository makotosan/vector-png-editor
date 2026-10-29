import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorePreviewRenderer } from '../src/corePreview.ts';
import { PreviewInvalidError, PreviewStaleError, PreviewUnavailableError } from '../src/preview.ts';
import { createTsCoreRuntime } from '../src/tsCore.ts';
import { loadHostFonts } from '../src/hostFonts.ts';

// The preview renderer runs in-process on the TypeScript Core
// (Issue #58), so these integration tests run by default - the
// engine is never faked.
const runtime = createTsCoreRuntime({ fonts: loadHostFonts() });
const VALID = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';

test('renders a valid edited source to a PNG data URI', async () => {
  const render = createCorePreviewRenderer({ runtime, width: 8, height: 8 });
  const uri = await render(VALID, 1);
  assert.ok(uri.startsWith('data:image/png;base64,'));
  const bytes = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.readUInt32BE(16), 8);
  assert.equal(bytes.readUInt32BE(20), 8);
});

test('hostile source is rejected by validation and never rendered', async () => {
  const render = createCorePreviewRenderer({ runtime, width: 8, height: 8 });
  await assert.rejects(
    render('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 1),
    PreviewInvalidError);
});

test('malformed XML is invalid, not unavailable', async () => {
  const render = createCorePreviewRenderer({ runtime, width: 8, height: 8 });
  await assert.rejects(render('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>', 1), PreviewInvalidError);
});

test('a render superseded by a newer source reports stale', async () => {
  const render = createCorePreviewRenderer({ runtime, width: 8, height: 8 });
  const first = render(VALID, 1);
  const second = render(VALID.replace('red', 'blue'), 2);
  await assert.rejects(first, PreviewStaleError);
  assert.ok((await second).startsWith('data:image/png;base64,'));
});

test('a host font environment that fails to load reports unavailable', async () => {
  const broken = createTsCoreRuntime({ fonts: Promise.reject(new Error('no fonts here')) });
  const render = createCorePreviewRenderer({ runtime: broken, width: 8, height: 8 });
  await assert.rejects(render(VALID, 1), PreviewUnavailableError);
});
