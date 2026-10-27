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
import { PreviewController } from './preview.ts';
import { createCorePreviewRenderer } from './corePreview.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const VIEW_TYPE = 'vectorPng.editor';

class VectorPngDocument implements vscode.CustomDocument {
  extracted: ExtractedSource | undefined;
  pendingSource: string | undefined;
  previewMode: 'saved' | 'edited' = 'saved';
  constructor(
    public readonly uri: vscode.Uri,
    public readonly width: number,
    public readonly height: number,
  ) {}
  dispose(): void {}
}

// Registration and routing are P2-01; the secure Monaco webview is P2-02;
// debounced Core-rendered previews and the manual saved/edited toggle are
// P2-03. The provider remains read-only at the VS Code level: edits update
// the in-memory model, advisory diagnostics and the edited preview only.
// The persisted save lifecycle is P2-04, which replaces this provider
// without changing the view type or commands.
class VectorPngEditorProvider implements vscode.CustomReadonlyEditorProvider<VectorPngDocument> {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri | undefined,
  ) {}

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
    const previewDirUri = this.storageUri
      ? vscode.Uri.joinPath(this.storageUri, 'previews')
      : vscode.Uri.joinPath(document.uri, '..');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, webviewRoot, vscode.Uri.joinPath(document.uri, '..'), previewDirUri],
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
      stateScriptUri: asUri(vscode.Uri.joinPath(webviewRoot, 'preview-state.js')),
    });

    const documentKey = createHash('sha256').update(document.uri.toString()).digest('hex').slice(0, 16);
    const pythonPath = vscode.workspace.getConfiguration('vectorPng').get<string>('corePythonPath');
    const preview = new PreviewController(
      createCorePreviewRenderer({
        pythonPath,
        previewDir: previewDirUri.fsPath,
        width: document.width,
        height: document.height,
        documentKey,
      }),
      (event) => {
        if (event.type === 'rendered') {
          const uri = panel.webview.asWebviewUri(vscode.Uri.file(join(event.imagePath)))
            .with({ query: `rev=${event.revision}` }).toString();
          void panel.webview.postMessage({ type: 'previewRendered', revision: event.revision, uri });
        } else if (event.type === 'invalid') {
          void panel.webview.postMessage({ type: 'previewInvalid', revision: event.revision, message: event.message });
        } else {
          void panel.webview.postMessage({ type: 'previewUnavailable', revision: event.revision, message: event.message });
        }
      },
    );
    // Show the Core-rendered edited preview for the untouched source too;
    // the pane still opens on the saved raster and never auto-switches.
    if (document.pendingSource !== undefined) preview.schedule(document.pendingSource, 0);

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
        preview.schedule(message.source, message.revision);
      } else if (message.type === 'setPreviewMode') {
        // Recorded for completeness; the host never changes the mode
        // itself - switching is a manual webview action only (P2-03).
        document.previewMode = message.mode;
      }
    });
    panel.onDidDispose(() => { subscription.dispose(); preview.dispose(); });
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
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new VectorPngEditorProvider(context.extensionUri, context.globalStorageUri), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('vectorPng.openInEditor', openInEditor),
    vscode.commands.registerCommand('vectorPng.newDocument', newDocument),
  );
}

export function deactivate(): void {}
