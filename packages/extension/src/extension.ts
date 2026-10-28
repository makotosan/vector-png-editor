import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
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
import { saveInPlace, saveAs } from './save.ts';
import { createCoreSaveDeps } from './coreSave.ts';
import { SourceHistory } from './history.ts';
import { writeBackup, readBackup, deleteBackup } from './backup.ts';

export const VIEW_TYPE = 'vectorPng.editor';

class VectorPngDocument implements vscode.CustomDocument {
  extracted: ExtractedSource | undefined;
  pendingSource: string | undefined;
  savedSource: string | undefined;
  previewMode: 'saved' | 'edited' = 'saved';
  saveSequence = 0;
  // The authoritative edit history (P2-05). Created with the document.
  history: SourceHistory = new SourceHistory('');
  private readonly sourceListeners = new Map<symbol, (source: string) => void>();
  private readonly savedListeners = new Set<() => void>();
  constructor(
    public readonly uri: vscode.Uri,
    public readonly width: number,
    public readonly height: number,
  ) {}
  // Pushes a source to every open webview except the one identified by
  // `origin`, without creating a new edit event. Used for undo/redo,
  // revert, restore and cross-panel synchronization.
  syncSource(source: string, origin?: symbol): void {
    this.pendingSource = source;
    for (const [id, listener] of this.sourceListeners) {
      if (id !== origin) listener(source);
    }
  }
  onSourceSync(id: symbol, listener: (source: string) => void): vscode.Disposable {
    this.sourceListeners.set(id, listener);
    return { dispose: () => this.sourceListeners.delete(id) };
  }
  notifySaved(): void {
    this.saveSequence += 1;
    for (const listener of this.savedListeners) listener();
  }
  onSaved(listener: () => void): vscode.Disposable {
    this.savedListeners.add(listener);
    return { dispose: () => this.savedListeners.delete(listener) };
  }
  dispose(): void {
    this.sourceListeners.clear();
    this.savedListeners.clear();
  }
}

type VectorPngEdit = {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
};

// Registration and routing are P2-01; the secure Monaco webview is P2-02;
// debounced Core-rendered previews and the manual toggle are P2-03; the
// source-preserving save lifecycle through the Core is P2-04; the
// authoritative undo/redo history, backup recovery and multi-panel
// synchronization are P2-05. External-change watching is P2-06; the
// save path itself already refuses to overwrite a changed destination
// without its current revision token.
class VectorPngEditorProvider implements vscode.CustomEditorProvider<VectorPngDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<VectorPngDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri | undefined,
  ) {}

  private corePythonPath(): string | undefined {
    return vscode.workspace.getConfiguration('vectorPng').get<string>('corePythonPath');
  }

  async openCustomDocument(uri: vscode.Uri): Promise<VectorPngDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const detection = detectPng(bytes);
    if (detection.kind !== 'vector-png')
      throw new Error(`Not a valid vector-png file: ${detection.kind === 'corrupt-vector-png' || detection.kind === 'not-png' ? detection.diagnostic : 'no embedded SVG source'}`);
    const document = new VectorPngDocument(uri, detection.width, detection.height);
    document.extracted = extractSource(bytes);
    document.pendingSource = document.extracted.text;
    document.savedSource = document.extracted.text;
    document.history = new SourceHistory(document.extracted.text);
    return document;
  }

  async openCustomDocumentBackup(backupId: string): Promise<VectorPngDocument> {
    const backupUri = vscode.Uri.parse(backupId);
    const sidecar = await readBackup(backupUri.fsPath);
    const document = await this.openCustomDocument(backupUri);
    if (sidecar) {
      // Restore with the unsaved edits intact and byte-exact; the
      // history restarts from the restored state (P2-05).
      const restored = new VectorPngDocument(vscode.Uri.parse(sidecar.originalUri), document.width, document.height);
      restored.extracted = document.extracted;
      restored.savedSource = sidecar.savedSource;
      restored.pendingSource = sidecar.source;
      restored.history = new SourceHistory(sidecar.source);
      return restored;
    }
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
    const savedUri = () => panel.webview.asWebviewUri(document.uri)
      .with({ query: `saved=${document.saveSequence}` }).toString();
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
    const preview = new PreviewController(
      createCorePreviewRenderer({
        pythonPath: this.corePythonPath(),
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
    const sendDiagnostics = (source: string) => {
      const diagnostics = diagnoseSource(source).map(d => ({ ...d, ...lineCol(source, d.offset) }));
      void panel.webview.postMessage({ type: 'diagnostics', diagnostics });
    };
    const panelId = Symbol('panel');
    const syncSubscription = document.onSourceSync(panelId, (source) => {
      void panel.webview.postMessage({ type: 'sourceSync', source });
      sendDiagnostics(source);
      preview.schedule(source, -1);
    });
    const savedSubscription = document.onSaved(() => {
      void panel.webview.postMessage({ type: 'saved', previewUri: savedUri() });
    });
    // Show the Core-rendered edited preview for the untouched source too;
    // the pane still opens on the saved raster and never auto-switches.
    if (document.pendingSource !== undefined) preview.schedule(document.pendingSource, 0);

    const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const validation = validateWebviewMessage(raw);
      if (!validation.ok) return; // Bounded protocol: drop invalid messages.
      const message = validation.message;
      if (message.type === 'ready') {
        void panel.webview.postMessage({
          type: 'init',
          previewUri: savedUri(),
          meta: `${document.width} x ${document.height} vector-png`,
          source: document.pendingSource ?? '',
          elements: SAFE_SVG_ELEMENTS,
          attributes: SAFE_SVG_ATTRIBUTES,
        });
        sendDiagnostics(document.pendingSource ?? '');
      } else if (message.type === 'sourceChanged') {
        const next = message.source;
        // The history is the single authority: an echo of a host sync
        // (or a no-op change) records nothing and fires no edit event,
        // so undo/redo can never feedback-loop (P2-05).
        if (!document.history.recordEdit(next, { now: Date.now(), coalesceKey: 'typing' })) return;
        document.pendingSource = next;
        sendDiagnostics(next);
        preview.schedule(next, message.revision);
        document.syncSource(next, panelId); // Keep other panels in step.
        const applyPointer = (source: string | undefined) => {
          if (source !== undefined) document.syncSource(source);
        };
        const edit: VectorPngEdit = {
          label: 'Edit SVG source',
          undo: async () => applyPointer(document.history.undo()),
          redo: async () => applyPointer(document.history.redo()),
        };
        this.changeEmitter.fire({ document, ...edit });
      } else if (message.type === 'setPreviewMode') {
        // Recorded for completeness; the host never changes the mode
        // itself - switching is a manual webview action only (P2-03).
        document.previewMode = message.mode;
      }
    });
    panel.onDidDispose(() => {
      subscription.dispose();
      syncSubscription.dispose();
      savedSubscription.dispose();
      preview.dispose();
    });
  }

  async saveCustomDocument(document: VectorPngDocument, cancellation: vscode.CancellationToken): Promise<void> {
    const source = document.pendingSource;
    if (source === undefined) throw new Error('Nothing to save');
    try {
      await saveInPlace(createCoreSaveDeps(this.corePythonPath()), document.uri.fsPath, {
        source, width: document.width, height: document.height,
        isCancelled: () => cancellation.isCancellationRequested,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Vector PNG save failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error; // Throwing keeps the document dirty and the buffer intact.
    }
    document.savedSource = source;
    document.notifySaved();
  }

  async saveCustomDocumentAs(document: VectorPngDocument, targetUri: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    const source = document.pendingSource;
    if (source === undefined) throw new Error('Nothing to save');
    try {
      await saveAs(createCoreSaveDeps(this.corePythonPath()), targetUri.fsPath, {
        source, width: document.width, height: document.height,
        isCancelled: () => cancellation.isCancellationRequested,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(`Vector PNG Save As failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    document.savedSource = source;
    document.notifySaved();
  }

  async revertCustomDocument(document: VectorPngDocument): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const extracted = extractSource(bytes);
    document.extracted = extracted;
    document.savedSource = extracted.text;
    document.history.reset(extracted.text);
    document.syncSource(extracted.text);
    document.notifySaved();
  }

  async backupCustomDocument(document: VectorPngDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    const destination = context.destination;
    await writeBackup(destination.fsPath, document.uri.fsPath, {
      originalUri: document.uri.toString(),
      source: document.pendingSource ?? '',
      savedSource: document.savedSource ?? '',
    });
    return {
      id: destination.toString(),
      delete: async () => deleteBackup(destination.fsPath),
    };
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
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('vectorPng.openInEditor', openInEditor),
    vscode.commands.registerCommand('vectorPng.newDocument', newDocument),
  );
}

export function deactivate(): void {}
