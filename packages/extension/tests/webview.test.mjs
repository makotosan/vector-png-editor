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

test('Monaco follows the VS Code colour theme (Issue #45, design B)', async () => {
  const js = await readFile(new URL('../webview/editor.js', import.meta.url), 'utf8');
  assert.match(js, /classList\.contains\('vscode-dark'\)/);
  assert.match(js, /monaco\.editor\.setTheme\(/);
  assert.match(js, /'vs-dark' : 'vs'/);
  assert.match(js, /MutationObserver\(syncMonacoTheme\)/);
});

test('word wrap toggles via the host command message and the Wrap button, persisted per panel (Issue #45)', async () => {
  const js = await readFile(new URL('../webview/editor.js', import.meta.url), 'utf8');
  assert.match(js, /message\.type === 'toggleWordWrap'\) \{\n    toggleWordWrap\(\);/, 'the host command message toggles wrap');
  assert.ok(!js.includes("'KeyZ'"), 'Alt+Z is owned by the workbench keybinding, not a page listener');
  assert.match(js, /const wrapButton = document\.getElementById\('tool-wrap'\);\nif \(wrapButton\) wrapButton\.addEventListener\('click', toggleWordWrap\)/, 'Wrap wiring is null-safe for pages retained across an upgrade');
  assert.match(js, /if \(button\) button\.setAttribute\('aria-pressed', String\(wordWrapOn\)\)/);
  assert.match(js, /wordWrap: wordWrapOn \? 'on' : 'off'/, 'editor creation takes the persisted choice');
  assert.match(js, /editor\.updateOptions\(\{ wordWrap: wordWrapOn \? 'on' : 'off' \}\)/);
  assert.match(js, /wordWrap: wordWrapOn,/, 'the choice is part of the persisted panel state');
  assert.match(js, /persistedPanel\.wordWrap === true/);
  const css = await readFile(new URL('../webview/editor.css', import.meta.url), 'utf8');
  assert.match(css, /#tool-wrap\[aria-pressed="true"\]/);
});

test('preview pane hides the image instead of a broken icon while the edited render is missing (Issue #45)', async () => {
  const js = await readFile(new URL('../webview/editor.js', import.meta.url), 'utf8');
  assert.match(js, /img\.removeAttribute\('src'\);\n    img\.style\.display = 'none';/);
  assert.match(js, /previewState\.editedRevision < revision \? 'Rendering the editing preview…' : ''/);
  assert.match(js, /'No editing preview yet\.'/);
});

test('Toggle Word Wrap is a workbench command with an Alt+Z keybinding (Issue #45)', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const command = manifest.contributes.commands.find((c) => c.command === 'vectorPng.toggleWordWrap');
  assert.ok(command, 'command contributed');
  assert.equal(command.title, 'Vector PNG: Toggle Word Wrap');
  assert.deepEqual(manifest.contributes.keybindings, [
    { command: 'vectorPng.toggleWordWrap', key: 'alt+z', when: 'activeCustomEditorId == vectorPng.editor' },
  ]);
  assert.ok(manifest.contributes.menus['webview/context'].some((m) => m.command === 'vectorPng.toggleWordWrap'), 'webview context menu entry');
  assert.ok(manifest.contributes.menus.commandPalette.some((m) => m.command === 'vectorPng.toggleWordWrap'), 'command palette entry');
  const host = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.match(host, /registerCommand\('vectorPng\.toggleWordWrap', \(\) => provider\.toggleWordWrapOnActivePanel\(\)\)/);
  assert.match(host, /postMessage\(\{ type: 'toggleWordWrap' \}\)/);
  assert.match(host, /this\.activeEditorPanel = panel;/, 'the provider tracks the active editor panel');
});

test('editor HTML (Issue #45) has the code toolbar and the Preview panel structure', () => {
  const html = buildEditorHtml(assets);
  for (const id of ['code-pane', 'code-toolbar', 'tool-save', 'tool-format', 'tool-wrap', 'editor',
    'preview-pane', 'preview-header', 'preview-title', 'bg-presets',
    'bg-checkerboard', 'bg-white', 'bg-black',
    'fill-row', 'fill-swatch', 'fill-text', 'fill-apply',
    'background-row', 'background-swatch', 'background-text',
    'preview-toggle', 'show-saved', 'show-edited', 'preview-status',
    'preview-area', 'preview', 'preview-actions', 'action-copy', 'action-export', 'action-export-png'])
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  assert.match(html, /id="tool-save" type="button">Save</);
  assert.match(html, /id="tool-format" type="button">Format</);
  assert.match(html, /id="tool-wrap" type="button" aria-pressed="false"[^>]*>Wrap</);
  assert.match(html, /id="preview-title">Preview</);
  assert.match(html, />FILL</);
  assert.match(html, />BACKGROUND</);
  assert.match(html, /id="fill-swatch" type="color"/);
  assert.match(html, /id="background-swatch" type="color"/);
  assert.match(html, /id="fill-apply" type="button">Apply</);
  assert.match(html, /id="show-saved" type="button">PNG</);
  assert.match(html, /id="show-edited" type="button">Editing</);
  assert.match(html, /id="action-copy" type="button">Copy</);
  assert.match(html, /id="action-export" type="button">Export</);
  assert.match(html, /id="action-export-png" type="button">Export PNG</);
  assert.match(html, /aria-pressed="true"/, 'one background preset starts pressed');
  assert.ok(!html.includes('<svg'), 'no SVG markup is ever placed in the DOM');
});

test('editor CSS follows the VS Code theme variables with design-B dark fallbacks (Issue #45)', async () => {
  const css = await readFile(new URL('../webview/editor.css', import.meta.url), 'utf8');
  for (const variable of ['--vscode-editor-background', '--vscode-sideBar-background', '--vscode-panel-border',
    '--vscode-button-background', '--vscode-button-foreground', '--vscode-button-secondaryBackground',
    '--vscode-input-background', '--vscode-input-border', '--vscode-foreground',
    '--vscode-descriptionForeground', '--vscode-focusBorder'])
    assert.ok(css.includes(`var(${variable}`), `missing theme variable ${variable}`);
  for (const fallback of ['#1e1e1e', '#252526', '#3c3c3c', '#0e639c'])
    assert.ok(css.includes(fallback), `missing design-B fallback ${fallback}`);
  assert.match(css, /#preview-area\.checkerboard \{[^}]*background-image: var\(--vpe-checker\)/);
  assert.match(css, /--vpe-checker: repeating-conic-gradient\(rgba\(128, 128, 128/);
  assert.match(css, /#action-export-png \{[^}]*background: var\(--vpe-accent\)/, 'Export PNG is the primary action');
  assert.match(css, /#tool-save \{[^}]*background: var\(--vpe-accent\)/, 'Save is the primary toolbar action');
  assert.match(css, /--vpe-btn-border: var\(--vscode-button-border, #858585\)/, 'buttons get a visible outline colour');
  assert.match(css, /--vpe-btn-radius: 6px/, 'buttons are rounded rectangles');
  assert.match(css, /button \{[^}]*border: 1px solid var\(--vpe-btn-border\); border-radius: var\(--vpe-btn-radius\)/, 'every button is a rounded-rect outline');
});

test('edited previews never load as webview resources (Issue #47 follow-up)', async () => {
  const csp = cspFor(assets);
  assert.match(csp, /img-src https:\/\/webview\.example data: blob:/,
    'the saved file loads from the webview origin; edited previews use data:/blob: URIs');
  const js = await readFile(new URL('../webview/editor.js', import.meta.url), 'utf8');
  assert.match(js, /URL\.createObjectURL\(new Blob\(\[source\], \{ type: 'image\/svg\+xml' \}\)\)/,
    'an SVG document renders its edited preview locally from the model text');
  assert.match(js, /The source has no <svg> root element to preview/,
    'a source without an svg root reports the invalid outcome instead of a broken image');
  const host = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.match(host, /data:image\/png;base64,\$\{Buffer\.from\(bytes\)\.toString\('base64'\)\}/,
    'a Core-rendered PNG preview is posted as a data URI');
  assert.match(host, /kind: document\.kind/, 'init tells the webview the document kind');
  assert.ok(!host.includes('createSvgPreviewRenderer'), 'the temporary-file SVG preview renderer is gone');
});

test('preview toggle opens on Editing; an SVG document disables the PNG view (Issue #45)', async () => {
  const js = await readFile(new URL('../webview/editor.js', import.meta.url), 'utf8');
  assert.match(js, /if \(persistedPanel\.previewMode === 'saved'\) previewState\.showSaved\(\);/,
    'only an explicitly persisted PNG choice restores the PNG view');
  assert.match(js, /pngButton\.disabled = true;/, 'the PNG button is disabled for SVG documents');
  assert.match(js, /An SVG file has no PNG image/, 'the disabled button explains itself');
  const css = await readFile(new URL('../webview/editor.css', import.meta.url), 'utf8');
  assert.match(css, /#preview-toggle button:disabled \{ opacity: 0\.45;/, 'the disabled PNG button is greyed out');
});
