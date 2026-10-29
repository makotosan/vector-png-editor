// Renderer tests against the real @resvg/resvg-wasm engine — the
// engine is never mocked. The corpus expectations are the Issue
// #57 spike's recorded dimensions (resvg-spike/results/metrics
// .json); per the migration plan, cross-engine pixel comparison
// and golden regeneration are deferred and NOT done here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvgToPng } from '../src/render.ts';
import { decodePng, parsePngHeader } from './png.mjs';
import { loadSpikeFonts } from './test-fonts.mjs';

const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const corpusDir = join(workspace, 'user/files');
const metricsPath = join(workspace, 'resvg-spike/results/metrics.json');
const corpusAvailable = existsSync(corpusDir) && existsSync(metricsPath);
const corpusTest = corpusAvailable ? test : test.skip;

corpusTest('every corpus SVG renders at the dimensions the spike recorded', async () => {
  const metrics = JSON.parse(await readFile(metricsPath, 'utf8'));
  const fonts = await loadSpikeFonts();
  const names = (await readdir(corpusDir)).filter((name) => name.endsWith('.svg')).sort();
  assert.equal(names.length, 9, 'the corpus is the nine user SVGs');
  for (const name of names) {
    const base = name.replace(/\.svg$/, '');
    const expected = metrics.files[base]?.resvg_dims;
    assert.ok(expected, `metrics.json has recorded dimensions for ${base}`);
    const source = await readFile(join(corpusDir, name), 'utf8');
    const { png, width, height } = await renderSvgToPng(source, { width: expected[0], height: expected[1], fonts });
    assert.deepEqual([width, height], expected, `${base}: returned size`);
    const header = parsePngHeader(png);
    assert.deepEqual([header.width, header.height], expected, `${base}: PNG IHDR size`);
  }
});

test('a transparent canvas stays (0,0,0,0) and fill-opacity 0.5 yields alpha 128', async () => {
  const blank = await renderSvgToPng(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>',
    { width: 40, height: 40, fonts: [] },
  );
  assert.deepEqual(decodePng(blank.png).pixelAt(20, 20), [0, 0, 0, 0]);

  // The spike's alpha probe: fill-opacity 0.5 red over a transparent
  // background is (255, 0, 0, 128) in both engines.
  const half = await renderSvgToPng(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
    + '<rect width="100" height="100" fill="#ff0000" fill-opacity="0.5"/></svg>',
    { width: 100, height: 100, fonts: [] },
  );
  assert.deepEqual(decodePng(half.png).pixelAt(50, 50), [255, 0, 0, 128]);
});

test('viewports beyond the Core caps are rejected without rendering', async () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
  // Side over 4096.
  await assert.rejects(renderSvgToPng(source, { width: 5000, height: 250, fonts: [] }), { code: 'resource-limit' });
  // Legal sides, total over 4,000,000 (2500 * 2500 = 6,250,000).
  await assert.rejects(renderSvgToPng(source, { width: 2500, height: 2500, fonts: [] }), { code: 'resource-limit' });
  // Just over the total (2000 * 2001 = 4,002,000).
  await assert.rejects(renderSvgToPng(source, { width: 2000, height: 2001, fonts: [] }), { code: 'resource-limit' });
  // Non-positive and non-integer sides.
  await assert.rejects(renderSvgToPng(source, { width: 0, height: 100, fonts: [] }), { code: 'resource-limit' });
  await assert.rejects(renderSvgToPng(source, { width: 100.5, height: 100, fonts: [] }), { code: 'resource-limit' });
});

test('a request that is not the document viewport fails instead of stretching', async () => {
  // resvg scales uniformly (fitTo width); a 20x20 document asked for
  // 20x10 cannot be honoured exactly, so the render is refused.
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">'
    + '<rect width="20" height="20" fill="#336699"/></svg>';
  await assert.rejects(renderSvgToPng(source, { width: 20, height: 10, fonts: [] }), { code: 'render-failed' });
});

test('external references are rejected before rendering; local fragments render', async () => {
  const fonts = [];
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    + '<image href="https://example.com/x.png" width="10" height="10"/></svg>';
  await assert.rejects(renderSvgToPng(image, { width: 10, height: 10, fonts }), { code: 'external-reference' });

  const use = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
    + '<use xlink:href="https://example.com/a.svg#x"/></svg>';
  await assert.rejects(renderSvgToPng(use, { width: 10, height: 10, fonts }), { code: 'external-reference' });

  const paintServer = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    + '<rect width="10" height="10" fill="url(http://example.com/g)"/></svg>';
  await assert.rejects(renderSvgToPng(paintServer, { width: 10, height: 10, fonts }), { code: 'external-reference' });

  const local = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">'
    + '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/>'
    + '<stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
    + '<rect width="20" height="20" fill="url(#g)"/></svg>';
  const rendered = await renderSvgToPng(local, { width: 20, height: 20, fonts });
  assert.deepEqual([rendered.width, rendered.height], [20, 20]);
  assert.equal(decodePng(rendered.png).pixelAt(10, 10)[3], 255, 'the gradient rect is opaque at its centre');
});
