// HTML shell for the editor webview. The shell contains only packaged
// asset URIs, a CSP and fixed element ids - never user content. The SVG
// source is delivered afterwards by message and shown in a Monaco model.
export type WebviewAssets = {
  cspSource: string;
  nonce: string;
  monacoVsUri: string;
  workerUri: string;
  styleUri: string;
  scriptUri: string;
  stateScriptUri: string;
};

export function cspFor(assets: WebviewAssets): string {
  return [
    `default-src 'none'`,
    `connect-src 'none'`,
    `img-src ${assets.cspSource} data: blob:`,
    `font-src ${assets.cspSource} data:`,
    // Monaco injects its own styles at runtime; scripts stay nonce-bound
    // and limited to packaged resources.
    `style-src ${assets.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${assets.nonce}' ${assets.cspSource}`,
    `worker-src ${assets.cspSource} blob:`,
  ].join('; ');
}

export function buildEditorHtml(assets: WebviewAssets): string {
  const config = JSON.stringify({ monacoVs: assets.monacoVsUri, workerUri: assets.workerUri });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${cspFor(assets)}">
<title>Vector PNG Editor</title>
<link rel="stylesheet" href="${assets.styleUri}">
</head>
<body>
<div id="panes">
  <div id="code-pane">
    <div id="code-toolbar" role="toolbar" aria-label="Source actions">
      <button id="tool-save" type="button">Save</button>
      <button id="tool-format" type="button">Format</button>
      <button id="tool-wrap" type="button" aria-pressed="false" title="Toggle word wrap (Alt+Z)">Wrap</button>
      <button id="tool-copy" type="button">Copy SVG</button>
      <span id="meta">Loading…</span>
    </div>
    <div id="editor"></div>
  </div>
  <div id="preview-pane">
    <div id="preview-header">
      <span id="preview-title">Preview</span>
      <div id="bg-presets" role="group" aria-label="Preview background">
        <button id="bg-checkerboard" type="button" title="Checkerboard background" aria-label="Checkerboard background" aria-pressed="true">▦</button>
        <button id="bg-white" type="button" title="White background" aria-label="White background" aria-pressed="false">■</button>
        <button id="bg-black" type="button" title="Black background" aria-label="Black background" aria-pressed="false">■</button>
      </div>
    </div>
    <div id="fill-row">
      <label id="fill-label" for="fill-text">FILL</label>
      <input id="fill-swatch" type="color" value="#000000" aria-label="Root fill colour">
      <input id="fill-text" type="text" placeholder="(none)" aria-label="Root fill value">
      <button id="fill-apply" type="button">Apply</button>
    </div>
    <div id="background-row">
      <label id="background-label" for="background-text">BACKGROUND</label>
      <input id="background-swatch" type="color" value="#ffffff" aria-label="Preview background colour">
      <input id="background-text" type="text" placeholder="#rrggbb" aria-label="Preview background colour value">
    </div>
    <div id="preview-mode-row">
      <div id="preview-toggle" role="group" aria-label="Preview source">
        <button id="show-saved" type="button">PNG</button>
        <button id="show-edited" type="button">Editing</button>
      </div>
      <div id="preview-status"></div>
    </div>
    <div id="preview-area">
      <img id="preview" alt="PNG preview">
    </div>
    <div id="preview-actions">
      <button id="action-export" type="button">Export SVG</button>
      <button id="action-export-png" type="button">Export Plain PNG</button>
    </div>
    <div id="preview-actions-svg" hidden>
      <button id="action-normalize" type="button">Normalize SVG</button>
      <button id="action-export-vector-png" type="button">Export as Vector PNG</button>
    </div>
  </div>
</div>
<script id="vpe-config" type="application/json" nonce="${assets.nonce}">${config}</script>
<script nonce="${assets.nonce}" src="${assets.monacoVsUri}/loader.js"></script>
<script nonce="${assets.nonce}" src="${assets.stateScriptUri}"></script>
<script nonce="${assets.nonce}" src="${assets.scriptUri}"></script>
</body>
</html>`;
}

// View-only shell for ordinary PNGs (Issue #46): no Monaco, no scripts at
// all - just the meta line and the raster image itself, centred on a
// checkerboard. `meta` is built by the host from the parsed PNG dimensions
// and fixed wording only; `imageUri` is the webview URI of the opened file.
// Nothing user-authored is interpolated into this shell.
export type ViewAssets = WebviewAssets & { imageUri: string; meta: string };

export function buildViewHtml(assets: ViewAssets): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${cspFor(assets)}">
<title>Vector PNG Editor</title>
<link rel="stylesheet" href="${assets.styleUri}">
</head>
<body>
<div id="meta">${assets.meta}</div>
<div id="view-pane">
  <img id="preview" src="${assets.imageUri}" alt="PNG image">
</div>
</body>
</html>`;
}
