import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { detectPng } from './detect.ts';
import { routeFor } from './routing.ts';
import { openModeFor } from './openMode.ts';
import { buildNewDocumentPng } from './newDocument.ts';
import { extractSource, type ExtractedSource } from './extract.ts';
import { validateWebviewMessage } from './messages.ts';
import { diagnoseSource, lineCol } from './diagnostics.ts';
import { SAFE_SVG_ATTRIBUTES, SAFE_SVG_ELEMENTS } from './profile.ts';
import { parseSchemaProfile, type SchemaProfile } from './profileData.ts';
import { readFileSync } from 'node:fs';
import { buildEditorHtml, buildViewHtml } from './webviewHtml.ts';
import { PreviewController } from './preview.ts';
import { createCorePreviewRenderer } from './corePreview.ts';
import { saveInPlace, saveAs } from './save.ts';
import { createCoreSaveDeps } from './coreSave.ts';
import { SourceHistory } from './history.ts';
import { writeBackup, readBackup, deleteBackup } from './backup.ts';
import { ExternalChangeTracker } from './watch.ts';
import { discoverPython, parseProbeOutput, PROBE_SCRIPT } from './pythonDiscovery.ts';
import { resolveCorePython, managedPython, locateCoreArtifacts } from './managedEnv.ts';
import { prepareEnvironment, rollbackEnvironment, EnvironmentError, isolatedEnvironment } from '../../bridge/src/environment.ts';
import { runBounded } from '../../bridge/src/process.ts';

export const VIEW_TYPE = 'vectorPng.editor';

class VectorPngDocument implements vscode.CustomDocument {
  extracted: ExtractedSource | undefined;
  pendingSource: string | undefined;
  savedSource: string | undefined;
  previewMode: 'saved' | 'edited' = 'saved';
  saveSequence = 0;
  // The authoritative edit history (P2-05). Created with the document.
  history: SourceHistory = new SourceHistory('');
  // External-change tracking (P2-06). Created with the document.
  tracker: ExternalChangeTracker = new ExternalChangeTracker('');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly noticeListeners = new Set<(text: string) => void>();
  trackDisposable(disposable: vscode.Disposable): void { this.disposables.push(disposable); }
  notifyNotice(text: string): void { for (const listener of this.noticeListeners) listener(text); }
  onNotice(listener: (text: string) => void): vscode.Disposable {
    this.noticeListeners.add(listener);
    return { dispose: () => this.noticeListeners.delete(listener) };
  }
  private readonly sourceListeners = new Map<symbol, (source: string) => void>();
  private readonly savedListeners = new Set<() => void>();
  constructor(
    public readonly uri: vscode.Uri,
    public readonly width: number,
    public readonly height: number,
    // View-only documents (ordinary PNGs, Issue #46) carry no source:
    // pendingSource stays undefined, so the save path has nothing to
    // write and the document can never become dirty.
    public readonly viewOnly: boolean = false,
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
    this.noticeListeners.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
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
// synchronization are P2-05; external-change watching with revision
// tokens, clean reload, dirty preservation and explicit conflict
// resolution at save is P2-06; Python discovery and the managed
// environment lifecycle (bridge manager) are P2-07.
// The generated safe-svg-v1 Monaco metadata (Issue #22 Phase 2):
// packaged under media/schemas, or read from the repo checkout during
// development. Absent or invalid data falls back to the mirrored
// constants in profile.ts - completion stays advisory either way and
// the Core validator remains authoritative.
let schemaProfileCache: SchemaProfile | null | undefined;
function loadSchemaProfile(extensionUri: vscode.Uri): SchemaProfile | null {
  if (schemaProfileCache !== undefined) return schemaProfileCache;
  const candidates = [
    join(extensionUri.fsPath, 'media', 'schemas', 'safe-svg-v1.monaco.json'),
    join(extensionUri.fsPath, '..', '..', 'schemas', 'safe-svg-v1.monaco.json'),
  ];
  for (const candidate of candidates) {
    try {
      schemaProfileCache = parseSchemaProfile(readFileSync(candidate, 'utf8'));
      return schemaProfileCache;
    } catch { /* try the next location, then fall back */ }
  }
  schemaProfileCache = null;
  return null;
}

class VectorPngEditorProvider implements vscode.CustomEditorProvider<VectorPngDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<VectorPngDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri | undefined,
    private readonly extensionDir: string,
    private readonly managedRoot: string,
  ) {}

  // Python resolution (P2-07): an explicit setting wins; otherwise
  // the managed environment's active interpreter.
  private corePythonPath(): Promise<string | undefined> {
    const configured = vscode.workspace.getConfiguration('vectorPng').get<string>('corePythonPath');
    return resolveCorePython(this.managedRoot, configured);
  }

  async openCustomDocument(uri: vscode.Uri): Promise<VectorPngDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const openMode = openModeFor(detectPng(bytes));
    if (openMode.mode === 'reject')
      throw new Error(`Not a valid vector-png file: ${openMode.diagnostic}`);
    const document = new VectorPngDocument(uri, openMode.width, openMode.height, openMode.mode === 'view');
    if (document.viewOnly) {
      // Issue #46: an ordinary PNG opens in view mode. No source is
      // extracted or fabricated, no watcher/history/tracker is set up,
      // and nothing is ever written back - opening and closing leaves
      // the file byte-identical.
      return document;
    }
    document.extracted = extractSource(bytes);
    document.pendingSource = document.extracted.text;
    document.savedSource = document.extracted.text;
    document.history = new SourceHistory(document.extracted.text);
    document.tracker = new ExternalChangeTracker(createHash('sha256').update(bytes).digest('hex'));
    this.watchDocument(document);
    return document;
  }

  private watchDocument(document: VectorPngDocument): void {
    const folder = vscode.Uri.joinPath(document.uri, '..');
    const name = document.uri.path.split('/').pop() ?? '';
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, name));
    document.trackDisposable(watcher.onDidChange(() => void this.handleDiskChange(document)));
    document.trackDisposable(watcher.onDidCreate(() => void this.handleDiskChange(document)));
    document.trackDisposable(watcher.onDidDelete(() => void this.handleDiskDelete(document)));
    document.trackDisposable(watcher);
  }

  private async readDiskState(document: VectorPngDocument): Promise<{ bytes: Uint8Array; sha: string } | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
    } catch {
      return undefined;
    }
  }

  private async reloadFromDisk(document: VectorPngDocument): Promise<boolean> {
    const state = await this.readDiskState(document);
    if (!state) return false;
    let extracted: ExtractedSource;
    try {
      const detection = detectPng(state.bytes);
      if (detection.kind !== 'vector-png') return false;
      extracted = extractSource(state.bytes);
    } catch {
      return false;
    }
    document.extracted = extracted;
    document.savedSource = extracted.text;
    document.history.reset(extracted.text);
    document.tracker.noteReloaded(state.sha);
    document.syncSource(extracted.text);
    document.notifySaved();
    return true;
  }

  private async handleDiskChange(document: VectorPngDocument): Promise<void> {
    const state = await this.readDiskState(document);
    if (!state) { void this.handleDiskDelete(document); return; }
    const dirty = document.history.isDirty(document.savedSource ?? '');
    // Never reload unchecked content: an unparsable change conflicts.
    let parseable = false;
    try { parseable = detectPng(state.bytes).kind === 'vector-png'; } catch { parseable = false; }
    const decision = parseable
      ? document.tracker.observe(state.sha, dirty)
      : document.tracker.observeUnreadable();
    if (decision === 'reload') {
      if (await this.reloadFromDisk(document))
        document.notifyNotice('Reloaded after an external change');
    } else if (decision === 'conflict') {
      document.notifyNotice('This file changed on disk. Your unsaved edits are preserved; saving will ask how to resolve it.');
      void vscode.window.showWarningMessage(
        'Vector PNG: the file changed on disk. Your unsaved edits are preserved and will not be overwritten silently.');
    }
  }

  private async handleDiskDelete(document: VectorPngDocument): Promise<void> {
    const dirty = document.history.isDirty(document.savedSource ?? '');
    const decision = document.tracker.observe(null, dirty);
    if (decision === 'deleted')
      document.notifyNotice('This file was deleted on disk');
    else if (decision === 'conflict')
      document.notifyNotice('This file was deleted on disk. Your unsaved edits are preserved; save to recreate it or use Save As.');
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
    const assets = {
      cspSource: panel.webview.cspSource,
      nonce,
      monacoVsUri: asUri(vscode.Uri.joinPath(mediaRoot, 'monaco', 'vs')),
      workerUri: asUri(vscode.Uri.joinPath(mediaRoot, 'monaco', 'vs', 'editor.worker.js')),
      styleUri: asUri(vscode.Uri.joinPath(webviewRoot, 'editor.css')),
      scriptUri: asUri(vscode.Uri.joinPath(webviewRoot, 'editor.js')),
      stateScriptUri: asUri(vscode.Uri.joinPath(webviewRoot, 'preview-state.js')),
    };
    if (document.viewOnly) {
      // Issue #46 view mode: a static, script-free page showing the
      // raster itself. No Monaco, no preview controller, no Core, no
      // message handling - and no diagnostics or notifications.
      panel.webview.options = {
        enableScripts: false,
        localResourceRoots: [mediaRoot, webviewRoot, vscode.Uri.joinPath(document.uri, '..')],
      };
      panel.webview.html = buildViewHtml({
        ...assets,
        imageUri: asUri(document.uri),
        meta: `${document.width} x ${document.height} PNG — no embedded SVG source (view only)`,
      });
      return;
    }
    panel.webview.html = buildEditorHtml(assets);

    const documentKey = createHash('sha256').update(document.uri.toString()).digest('hex').slice(0, 16);
    const preview = new PreviewController(
      createCorePreviewRenderer({
        pythonPath: await this.corePythonPath(),
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
    const noticeSubscription = document.onNotice((text) => {
      void panel.webview.postMessage({ type: 'notice', text });
    });
    // Show the Core-rendered edited preview for the untouched source too;
    // the pane still opens on the saved raster and never auto-switches.
    if (document.pendingSource !== undefined) preview.schedule(document.pendingSource, 0);

    const schemaProfile = loadSchemaProfile(this.extensionUri);
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
          elements: schemaProfile?.elements ?? SAFE_SVG_ELEMENTS,
          attributes: schemaProfile?.attributes ?? SAFE_SVG_ATTRIBUTES,
          children: schemaProfile?.children ?? {},
          textElements: schemaProfile?.textElements ?? [],
          profileVersion: schemaProfile?.version ?? null,
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
      noticeSubscription.dispose();
      preview.dispose();
    });
  }

  async saveCustomDocument(document: VectorPngDocument, cancellation: vscode.CancellationToken): Promise<void> {
    const source = document.pendingSource;
    if (source === undefined) throw new Error('Nothing to save');
    // P2-06: a known external conflict must be resolved explicitly -
    // a plain save never silently overwrites the external version.
    if (document.tracker.isConflicted && !document.tracker.isDeleted) {
      const choice = await vscode.window.showErrorMessage(
        'This file changed on disk since it was opened. Your version and the disk version both still exist.',
        { modal: true }, 'Reload from disk', 'Overwrite the external change', 'Save As...');
      if (choice === 'Reload from disk') {
        if (await this.reloadFromDisk(document)) return; // Adopted the disk version; nothing left to save.
        throw new Error('Could not reload the changed file; your edits are preserved');
      }
      if (choice === 'Save As...') {
        const target = await vscode.window.showSaveDialog({ filters: { 'Vector PNG': ['png'] }, saveLabel: 'Save As' });
        if (!target) throw new Error('Save cancelled');
        await this.saveCustomDocumentAs(document, target, cancellation);
        return;
      }
      if (choice !== 'Overwrite the external change') throw new Error('Save cancelled');
      document.tracker.resolveOverwrite();
    }
    const deps = createCoreSaveDeps(await this.corePythonPath());
    try {
      if (document.tracker.isDeleted) {
        // Recreate a file deleted on disk from the preserved buffer.
        await saveAs(deps, document.uri.fsPath, {
          source, width: document.width, height: document.height,
          isCancelled: () => cancellation.isCancellationRequested,
        });
      } else {
        await saveInPlace(deps, document.uri.fsPath, {
          source, width: document.width, height: document.height,
          isCancelled: () => cancellation.isCancellationRequested,
        });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Vector PNG save failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error; // Throwing keeps the document dirty and the buffer intact.
    }
    document.savedSource = source;
    const state = await this.readDiskState(document);
    if (state) document.tracker.noteSaved(state.sha);
    document.notifySaved();
  }

  async saveCustomDocumentAs(document: VectorPngDocument, targetUri: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    const source = document.pendingSource;
    if (source === undefined) throw new Error('Nothing to save');
    try {
      await saveAs(createCoreSaveDeps(await this.corePythonPath()), targetUri.fsPath, {
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
    // View-only documents hold no source and can never be dirty; a
    // revert is a no-op rather than an extraction failure (Issue #46).
    if (document.viewOnly) return;
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const extracted = extractSource(bytes);
    document.extracted = extracted;
    document.savedSource = extracted.text;
    document.history.reset(extracted.text);
    document.tracker.noteReloaded(createHash('sha256').update(bytes).digest('hex'));
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

const PYTHON_HINT = 'Install Python 3.11-3.13 from https://www.python.org/downloads/ (Windows: tick "Add python.exe to PATH" or install the py launcher; macOS: the python.org installer or Homebrew; Linux: your distribution packages), then run the setup command again.';
const CAIRO_HINT = 'The Core also needs the native Cairo library: Windows - install the GTK runtime; macOS - `brew install cairo`; Linux - install libcairo2 from your distribution. Then run the setup command again.';

async function probeCandidate(candidate: { command: string; args: string[] }) {
  const { stdout } = await runBounded(candidate.command, [...candidate.args, '-I', '-c', PROBE_SCRIPT], {
    env: isolatedEnvironment(), cwd: process.cwd(), timeoutMs: 15_000,
  });
  return parseProbeOutput(stdout);
}

async function setupEnvironment(context: vscode.ExtensionContext, managedRoot: string): Promise<void> {
  const discovery = await discoverPython(probeCandidate, process.platform);
  if (!discovery.selected) {
    const found = discovery.unsupported.map((u) => `${u.version.join('.')} (${u.via})`).join(', ');
    void vscode.window.showErrorMessage(
      `Vector PNG: no supported Python found.${found ? ` Found only unsupported versions: ${found}.` : ''} ${PYTHON_HINT}`);
    return;
  }
  const artifacts = await locateCoreArtifacts({
    extensionDir: context.extensionPath,
    wheelSetting: vscode.workspace.getConfiguration('vectorPng').get<string>('coreWheelPath'),
  });
  if (!artifacts) {
    void vscode.window.showErrorMessage(
      'Vector PNG: no Core wheel found. Set "vectorPng.coreWheelPath" to a trusted vector_png_editor_core wheel, or install a build that bundles one.');
    return;
  }
  const allowNetwork = await vscode.window.showInformationMessage(
    `Set up the managed Python environment from the Core ${artifacts.version} wheel (${artifacts.source})? Dependencies install from the pinned lock; setup never touches your system Python, and a failure keeps the current environment.`,
    { modal: true }, 'Set up (offline, local wheelhouse only)', 'Set up (allow network)');
  if (!allowNetwork) return;
  const controller = new AbortController();
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Vector PNG: setting up the Python environment', cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        return prepareEnvironment({
          root: managedRoot, python: discovery.selected!.executable,
          wheel: artifacts.wheel, wheelSha256: artifacts.wheelSha256, version: artifacts.version,
          requirements: artifacts.requirements, requirementsSha256: artifacts.requirementsSha256,
          allowNetwork: allowNetwork.includes('allow network'), signal: controller.signal,
          onProgress: (stage) => progress.report({ message: stage }),
        });
      });
    void vscode.window.showInformationMessage(`Vector PNG: environment ready (${result.python}). Edited previews and saving now use the Python Core.`);
  } catch (error) {
    const stage = error instanceof EnvironmentError ? error.stage : '';
    const message = error instanceof Error ? error.message : String(error);
    const hint = /cairo|render/i.test(stage + message) ? ` ${CAIRO_HINT}` : '';
    void vscode.window.showErrorMessage(`Vector PNG setup failed (${stage || 'error'}): ${message}. The previous environment, if any, is unchanged.${hint}`);
  }
}

async function environmentStatus(managedRoot: string): Promise<void> {
  const configured = vscode.workspace.getConfiguration('vectorPng').get<string>('corePythonPath');
  const managed = await managedPython(managedRoot);
  const effective = await resolveCorePython(managedRoot, configured);
  const lines = [
    `Configured Python: ${configured?.trim() ? configured : '(not set)'}`,
    `Managed environment: ${managed ?? '(none - run "Vector PNG: Set Up Python Environment")'}`,
    `Effective Python: ${effective ?? '(none - edited previews and saving are unavailable; the saved PNG preview still works)'}`,
  ];
  void vscode.window.showInformationMessage(lines.join('  '), { modal: true });
}

export function activate(context: vscode.ExtensionContext): void {
  const managedRoot = join(context.globalStorageUri.fsPath, 'managed-env');
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new VectorPngEditorProvider(context.extensionUri, context.globalStorageUri, context.extensionPath, managedRoot), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('vectorPng.openInEditor', openInEditor),
    vscode.commands.registerCommand('vectorPng.newDocument', newDocument),
    vscode.commands.registerCommand('vectorPng.setupEnvironment', () => setupEnvironment(context, managedRoot)),
    vscode.commands.registerCommand('vectorPng.environmentStatus', () => environmentStatus(managedRoot)),
    vscode.commands.registerCommand('vectorPng.rollbackEnvironment', async () => {
      try {
        const result = await rollbackEnvironment({ root: managedRoot });
        void vscode.window.showInformationMessage(`Vector PNG: rolled back to the previous environment (${result.python}).`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Vector PNG rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}

export function deactivate(): void {}
