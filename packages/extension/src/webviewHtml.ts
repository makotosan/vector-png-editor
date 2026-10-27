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
};

export function cspFor(assets: WebviewAssets): string {
  return [
    `default-src 'none'`,
    `connect-src 'none'`,
    `img-src ${assets.cspSource}`,
    `font-src ${assets.cspSource}`,
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
<div id="meta">Loading…</div>
<div id="panes">
  <div id="preview-pane"><img id="preview" alt="Saved PNG preview"></div>
  <div id="editor"></div>
</div>
<script id="vpe-config" type="application/json" nonce="${assets.nonce}">${config}</script>
<script nonce="${assets.nonce}" src="${assets.monacoVsUri}/loader.js"></script>
<script nonce="${assets.nonce}" src="${assets.scriptUri}"></script>
</body>
</html>`;
}
