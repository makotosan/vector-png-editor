import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEditorHtml, buildViewHtml, cspFor } from '../src/webviewHtml.ts';

const assets = { cspSource: 'https://webview.example', nonce: 'abc123', monacoVsUri: 'https://webview.example/monaco/vs', workerUri: 'https://webview.example/monaco/vs/editor.worker.js', styleUri: 'https://webview.example/editor.css', scriptUri: 'https://webview.example/editor.js' };

test('CSP blocks network and limits scripts to nonce plus packaged resources', () => {
  const csp = cspFor(assets);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc123' https:\/\/webview\.example/);
  assert.match(csp, /worker-src https:\/\/webview\.example blob:/);
});

test('HTML shell contains no user SVG and loads only local assets', () => {
  const html = buildEditorHtml(assets);
  assert.ok(!html.includes('<svg'));
  assert.ok(!/src="https?:\/\/(?!webview\.example)/.test(html));
  assert.match(html, /loader\.js/);
});

test('view-only HTML (Issue #46) shows the image and the view-only notice, with no scripts and no Monaco', () => {
  const html = buildViewHtml({ ...assets, imageUri: 'https://webview.example/plain.png', meta: '3 x 5 PNG — no embedded SVG source (view only)' });
  assert.match(html, /no embedded SVG source \(view only\)/);
  assert.match(html, /<img id="preview" src="https:\/\/webview\.example\/plain\.png"/);
  assert.match(html, /id="view-pane"/);
  assert.ok(!html.includes('<script'), 'view mode loads no scripts at all');
  assert.ok(!html.includes('loader.js'), 'view mode loads no Monaco');
  assert.ok(!html.includes('<svg'), 'view mode fabricates no SVG source');
  assert.match(html, /Content-Security-Policy/);
});

test('view-only CSS centres the raster on a checkerboard', async () => {
  const css = await readFile(new URL('../webview/editor.css', import.meta.url), 'utf8');
  assert.match(css, /#view-pane \{[^}]*repeating-conic-gradient/);
  assert.match(css, /#view-pane \{[^}]*align-items: center/);
  assert.match(css, /#view-pane \{[^}]*justify-content: center/);
});

test('webview script uses no CDN, no innerHTML, and posts only protocol messages', async () => {
  const js = await readFile(new URL('../webview/editor.js', import.meta.url), 'utf8');
  assert.ok(!/https?:\/\//.test(js.replace('http://www.w3.org/2000/svg', '')), 'no external URLs');
  assert.ok(!js.includes('innerHTML'));
  assert.ok(!js.includes('eval('));
  assert.ok(js.includes("postMessage({ type: 'ready' })") || js.includes('type: \'sourceChanged\''));
  assert.match(js, /MonacoEnvironment/);
});
