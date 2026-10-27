import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { detectPng } from './detect.ts';
import { routeFor } from './routing.ts';
import { buildNewDocumentPng } from './newDocument.ts';
import { extractSource, type ExtractedSource } from './extract.ts';
import { validateWebviewMessage } from './messages.ts';
import { diagnoseSource, lineCol } from './diagnostics.ts';
import { SAFE_SVG_ATTRIBUTES, SAFE_SVG_ELEMENTS } from './profile.ts';
import { buildEditorHtml } from './webviewHtml.ts';

export const VIEW_TYPE = 'vectorPng.editor';

class VectorPngDocument implements vscode.CustomDocument {
  extracted: ExtractedSource | undefined;
  pendingSource: string | undefined;
  constructor(
    public readonly uri: vscode.Uri,
    public readonly width: number,
    public readonly height: number,
  ) {}
  dispose(): void {}
}

// Registration and routing are P2-01; the secure Monaco webview is P2-02.
// The provider remains read-only at the VS Code level: edits update the
// in-memory model and advisory diagnostics only. Preview rendering is
// P2-03 and the persisted save lifecycle is P2-04, which replaces this
// provider without changing the view type or commands.
class VectorPngEditorProvider implements vscode.CustomReadonlyEditorProvider<VectorPngDocument> {
  constructor(private readonly extensionUri: vscode.Uri) {}

  async openCustomDocument(uri: vscode.Uri): Promise<VectorPngDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const detection = detectPng(bytes);
    if (detection.kind !== 'vector-png')
      throw new Error(`Not a valid vector-png file: ${detection.kind === 'corrupt-vector-png' || detection.kind === 'not-png' ? detection.diagnostic : 'no embedded SVG source'}`);
    const document = new VectorPngDocument(uri, detection.width, detection.height);
    document.extracted = extractSource(bytes);
    document.pendingSource = document.extracted.text;
    return document;
  }

  async resolveCustomEditor(document: VectorPngDocument, panel: vscode.WebviewPanel): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'webview');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, webviewRoot, vscode.Uri.joinPath(document.uri, '..')],
    };
    const asUri = (uri: vscode.Uri) => panel.webview.asWebviewUri(uri).toString();
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = buildEditorHtml({
      cspSource: panel.webview.cspSource,
      nonce,
      monacoVsUri: asUri(vscode.Uri.joinPath(mediaRoot, 'monaco', 'vs')),
      workerUri: asUri(vscode.Uri.joinPath(mediaRoot, 'monaco', 'vs', 'editor.worker.js')),
      styleUri: asUri(vscode.Uri.joinPath(webviewRoot, 'editor.css')),
      scriptUri: asUri(vscode.Uri.joinPath(webviewRoot, 'editor.js')),
    });

    const sendDiagnostics = (source: string) => {
      const diagnostics = diagnoseSource(source).map(d => ({
        ...d, ...lineCol(source, d.offset),
      }));
      void panel.webview.postMessage({ type: 'diagnostics', diagnostics });
    };
    const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const validation = validateWebviewMessage(raw);
      if (!validation.ok) return; // Bounded protocol: drop invalid messages.
      const message = validation.message;
      if (message.type === 'ready') {
        void panel.webview.postMessage({
          type: 'init',
          previewUri: asUri(document.uri),
          meta: `${document.width} x ${document.height} vector-png - source editing is not saved yet (save arrives in P2-04)`,
          source: document.pendingSource ?? '',
          elements: SAFE_SVG_ELEMENTS,
          attributes: SAFE_SVG_ATTRIBUTES,
        });
        sendDiagnostics(document.pendingSource ?? '');
      } else if (message.type === 'sourceChanged') {
        document.pendingSource = message.source;
        sendDiagnostics(message.source);
      }
    });
    panel.onDidDispose(() => subscription.dispose());
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
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new VectorPngEditorProvider(context.extensionUri), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('vectorPng.openInEditor', openInEditor),
    vscode.commands.registerCommand('vectorPng.newDocument', newDocument),
  );
}

export function deactivate(): void {}
