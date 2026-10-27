import * as vscode from 'vscode';
import { detectPng } from './detect.ts';
import { routeFor } from './routing.ts';
import { buildNewDocumentPng } from './newDocument.ts';

export const VIEW_TYPE = 'vectorPng.editor';

class VectorPngDocument implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly width: number,
    public readonly height: number,
  ) {}
  dispose(): void {}
}

// P2-01 registers the editor as read-only: it proves registration and open
// routing end to end. The editable CustomDocument lifecycle (Monaco source
// editing, save, undo/redo, backup) is P2-02/P2-04 scope and must replace
// this provider without changing the view type or the routing command.
class VectorPngEditorProvider implements vscode.CustomReadonlyEditorProvider<VectorPngDocument> {
  async openCustomDocument(uri: vscode.Uri): Promise<VectorPngDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const detection = detectPng(bytes);
    if (detection.kind !== 'vector-png')
      throw new Error(`Not a valid vector-png file: ${detection.kind === 'corrupt-vector-png' || detection.kind === 'not-png' ? detection.diagnostic : 'no embedded SVG source'}`);
    return new VectorPngDocument(uri, detection.width, detection.height);
  }

  async resolveCustomEditor(document: VectorPngDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: false, localResourceRoots: [vscode.Uri.joinPath(document.uri, '..')] };
    const image = panel.webview.asWebviewUri(document.uri);
    const csp = panel.webview.cspSource;
    // The preview shows the saved PNG raster itself. Embedded SVG is never
    // inserted into the DOM and no script runs in this webview.
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src 'unsafe-inline'">
<title>Vector PNG</title>
</head>
<body>
<p>${document.width} x ${document.height} vector-png. Source editing arrives with the Monaco editor (P2-02).</p>
<img src="${image}" alt="Saved PNG preview">
</body>
</html>`;
  }
}

async function openInEditor(target?: vscode.Uri): Promise<void> {
  const uri = target ?? vscode.window.activeTextEditor?.document.uri
    ?? (await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'PNG images': ['png'] },
      openLabel: 'Open in Vector PNG Editor',
    }))?.[0];
  if (!uri) return;
  const bytes = await vscode.workspace.fs.readFile(uri);
  const route = routeFor(detectPng(bytes), uri.path.split('/').pop() ?? uri.path);
  if (route.action === 'open-custom-editor') {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  } else if (route.action === 'open-default-viewer') {
    await vscode.commands.executeCommand('vscode.open', uri);
  } else {
    await vscode.window.showErrorMessage(route.message);
  }
}

async function newDocument(): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    filters: { 'Vector PNG': ['png'] },
    saveLabel: 'Create Vector PNG',
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, buildNewDocumentPng());
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new VectorPngEditorProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('vectorPng.openInEditor', openInEditor),
    vscode.commands.registerCommand('vectorPng.newDocument', newDocument),
  );
}

export function deactivate(): void {}
