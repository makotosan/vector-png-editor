// The host-supplied wasm source (setWasmSource): a host whose module
// layout cannot resolve @resvg/resvg-wasm from this package — the
// bundled VS Code extension — hands the binary over explicitly.
// This file runs in its own test process, so the override is what
// initialises the module here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderSvgToPng, setWasmSource } from '../src/render.ts';

const require = createRequire(import.meta.url);
setWasmSource(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));

test('renders with the wasm supplied by path via setWasmSource', async () => {
  const { png, width, height } = await renderSvgToPng(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
    { width: 4, height: 4, fonts: [] },
  );
  assert.equal(width, 4);
  assert.equal(height, 4);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
