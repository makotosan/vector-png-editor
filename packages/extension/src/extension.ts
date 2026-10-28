import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { detectPng } from './detect.ts';
import { routeFor, routeForFile } from './routing.ts';
import { openModeFor } from './openMode.ts';
import { decodeSvgText, isSvgFileName, svgDocumentSize } from './svgSource.ts';
import { createSvgPreviewRenderer } from './svgPreview.ts';
import { createNodeSvgSaveDeps, saveSvgTextFile, SvgSaveConflictError } from './svgSave.ts';
import { exportSvgAsVectorPng, formatProfileDiagnostics, type ProfileDiagnostic } from './export.ts';
import { createCoreExportDeps, createCorePlainPngDeps } from './coreExport.ts';
import { isValidFillValue, readRootFill, setRootFill } from './rootFill.ts';
import { formatSvgSource } from './formatSource.ts';
import { exportPlainPng } from './exportPng.ts';
import { applyNormalizedEdit, formatNormalizeErrors, formatNormalizeSummary, normalizeSourceText } from './normalize.ts';
import { createCoreNormalizeDeps } from './coreNormalize.ts';
import { buildNewDocumentPng } from './newDocument.ts';
import { extractSource, type ExtractedSource } from './extract.ts';
import { validateWebviewMessage } from './messages.ts';
import { diagnoseSource, lineCol } from './diagnostics.ts';
import { SAFE_SVG_ATTRIBUTES, SAFE_SVG_ELEMENTS, MAX_SVG_BYTES } from './profile.ts';
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

// A document is either a vector-png (its source lives inside the PNG)
// or a plain `.svg` file (the file itself is the source, Issue #47).
// Both share the editing model - pending/saved source, history,
// tracker, panels; only acquisition, preview rendering and the save
// write differ by kind.
export type DocumentKind = 'vector-png' | 'svg';

class VectorPngDocument implements vscode.CustomDocument {
  extracted: ExtractedSource | undefined;
  pendingSource: string | undefined;
  savedSource: string | undefined;
  previewMode: 'saved' | 'edited' = 'saved';
  saveSequence = 0;
  private disposedFlag = false;
  get isDisposed(): boolean { return this.disposedFlag; }
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
    public readonly kind: DocumentKind = 'vector-png',
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
    this.disposedFlag = true;
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
// environment lifecycle (bridge manager) are P2-07. Plain `.svg`
// documents (open/edit/save as text, export as vector-png through the
// Core `build` or the normalization `convert` route, and the explicit
// undoable Normalize SVG command) are Issue #47.
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
  // The editable-editor panel that is currently active, if any, so
  // workbench commands (Toggle Word Wrap, Alt+Z) can reach its
  // webview. Tracked from the panels' view-state changes.
  private activeEditorPanel: vscode.WebviewPanel | undefined;
  // Live documents by URI string, so commands (export) can find the
  // open document - and its possibly unsaved source - for a file.
  private readonly documents = new Map<string, VectorPngDocument>();

  private registerDocument(document: VectorPngDocument): void {
    this.documents.set(document.uri.toString(), document);
  }

  findOpenDocument(uri: vscode.Uri): VectorPngDocument | undefined {
    const document = this.documents.get(uri.toString());
    if (document && document.isDisposed) {
      this.documents.delete(uri.toString());
      return undefined;
    }
    return document;
  }

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
    if (isSvgFileName(uri.path.split('/').pop() ?? '')) return this.openSvgDocument(uri, bytes);
    const openMode = openModeFor(detectPng(bytes));
    if (openMode.mode === 'reject')
      throw new Error(`Not a valid vector-png file: ${openMode.diagnostic}`);
    const document = new VectorPngDocument(uri, openMode.width, openMode.height, 'vector-png', openMode.mode === 'view');
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
    this.registerDocument(document);
    return document;
  }

  // A plain `.svg` file opens as its own source text. Display is never
  // blocked by safe-svg-v1 validation: the only refusals are the
  // editor's resource limits (byte cap, valid UTF-8), shared with the
  // PNG source path.
  private openSvgDocument(uri: vscode.Uri, bytes: Uint8Array): VectorPngDocument {
    if (bytes.length > MAX_SVG_BYTES)
      throw new Error(`This SVG file exceeds the editor source limit of ${MAX_SVG_BYTES} bytes`);
    const text = decodeSvgText(bytes);
    if (text === null) throw new Error('This SVG file is not valid UTF-8 text');
    const size = svgDocumentSize(text);
    const document = new VectorPngDocument(uri, size.width, size.height, 'svg');
    document.pendingSource = text;
    document.savedSource = text;
    document.history = new SourceHistory(text);
    document.tracker = new ExternalChangeTracker(createHash('sha256').update(bytes).digest('hex'));
    this.watchDocument(document);
    this.registerDocument(document);
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
    if (document.kind === 'svg') {
      const text = decodeSvgText(state.bytes);
      if (text === null) return false;
      document.savedSource = text;
      document.history.reset(text);
      document.tracker.noteReloaded(state.sha);
      document.syncSource(text);
      document.notifySaved();
      return true;
    }
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
    // For an SVG document "parsable" means decodable source text - the
    // profile never gates display, so conformance is not checked here.
    let parseable = false;
    try {
      parseable = document.kind === 'svg'
        ? decodeSvgText(state.bytes) !== null
        : detectPng(state.bytes).kind === 'vector-png';
    } catch { parseable = false; }
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
    // The backup destination carries no meaningful file name, so an
    // SVG backup is recognized through its sidecar's original URI.
    const svgBackup = sidecar !== undefined
      && isSvgFileName(vscode.Uri.parse(sidecar.originalUri).path.split('/').pop() ?? '');
    const document = svgBackup
      ? this.openSvgDocument(backupUri, await vscode.workspace.fs.readFile(backupUri))
      : await this.openCustomDocument(backupUri);
    if (sidecar) {
      // Restore with the unsaved edits intact and byte-exact; the
      // history restarts from the restored state (P2-05).
      const restored = new VectorPngDocument(vscode.Uri.parse(sidecar.originalUri), document.width, document.height, document.kind);
      restored.extracted = document.extracted;
      restored.savedSource = sidecar.savedSource;
      restored.pendingSource = sidecar.source;
      restored.history = new SourceHistory(sidecar.source);
      this.registerDocument(restored);
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
    // Preview rendering differs by kind: a vector-png's edited source
    // renders through the Core (which validates first), while a plain
    // SVG renders as-is from a private file - the Core preview path
    // cannot show a non-conforming SVG at all, and display is never
    // blocked by the profile (Issue #47).
    const renderer = document.kind === 'svg'
      ? createSvgPreviewRenderer({ previewDir: previewDirUri.fsPath, documentKey })
      : createCorePreviewRenderer({
          pythonPath: await this.corePythonPath(),
          previewDir: previewDirUri.fsPath,
          width: document.width,
          height: document.height,
          documentKey,
        });
    const preview = new PreviewController(
      renderer,
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
    // Issue #45: the FILL row mirrors the root element's fill. The
    // host owns the value; the webview only displays what it is sent.
    const postRootFill = () => {
      const fill = readRootFill(document.pendingSource ?? '');
      void panel.webview.postMessage({ type: 'rootFill', available: fill.available, value: fill.value });
    };
    const syncSubscription = document.onSourceSync(panelId, (source) => {
      void panel.webview.postMessage({ type: 'sourceSync', source });
      postRootFill();
      sendDiagnostics(source);
      preview.schedule(source, -1);
    });
    const savedSubscription = document.onSaved(() => {
      void panel.webview.postMessage({ type: 'saved', previewUri: savedUri() });
    });
    const noticeSubscription = document.onNotice((text) => {
      void panel.webview.postMessage({ type: 'notice', text });
    });
    // Menu enablement for kind-specific commands (Normalize SVG is
    // .svg-only): track the active panel's document kind as context.
    // The same hook tracks the active editor panel itself, so the
    // Toggle Word Wrap command can post to its webview.
    const updateKindContext = () => {
      if (panel.active) {
        this.activeEditorPanel = panel;
        void vscode.commands.executeCommand('setContext', 'vectorPng.documentIsSvg', document.kind === 'svg');
      } else if (this.activeEditorPanel === panel) {
        this.activeEditorPanel = undefined;
      }
    };
    const viewStateSubscription = panel.onDidChangeViewState(updateKindContext);
    updateKindContext();
    // Show the Core-rendered edited preview for the untouched source too;
    // the pane still opens on the saved raster and never auto-switches.
    if (document.pendingSource !== undefined) preview.schedule(document.pendingSource, 0);

    // Issue #45 panel actions. A host-originated source change (root
    // fill, Format) goes through the same machinery as Normalize
    // SVG: one history edit under its own coalesce key, made pending
    // and synced to every panel, with the edit event fired so VS
    // Code's undo stack tracks it. Returns false when the history
    // refused the edit (identical snapshot), i.e. nothing changed.
    const applyHostEdit = (next: string, label: string, coalesceKey: string): boolean => {
      if (!document.history.recordEdit(next, { now: Date.now(), coalesceKey })) return false;
      document.pendingSource = next;
      document.syncSource(next);
      const applyPointer = (source: string | undefined) => {
        if (source !== undefined) document.syncSource(source);
      };
      const edit: VectorPngEdit = {
        label,
        undo: async () => applyPointer(document.history.undo()),
        redo: async () => applyPointer(document.history.redo()),
      };
      this.changeEmitter.fire({ document, ...edit });
      return true;
    };
    const documentStem = () => (document.uri.path.split('/').pop() ?? 'document').replace(/\.(png|svg)$/i, '');
    // Export writes the CURRENT source as a standalone .svg beside
    // the document (a "-copy" name for .svg documents). The open
    // document and its file are never the export target.
    const exportSourceToFile = async (): Promise<void> => {
      const source = document.pendingSource ?? document.savedSource ?? '';
      const defaultName = document.kind === 'svg' ? `${documentStem()}-copy.svg` : `${documentStem()}.svg`;
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(document.uri, '..', defaultName),
        filters: { 'SVG images': ['svg'] },
        saveLabel: 'Export SVG',
      });
      if (!target) return;
      if (target.fsPath === document.uri.fsPath) {
        document.notifyNotice('Export refused: the open document itself cannot be the export target.');
        return;
      }
      try {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(source));
        void vscode.window.showInformationMessage(`Vector PNG: SVG exported: ${target.fsPath}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Vector PNG: SVG export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // Export PNG renders through the Core (exportPng.ts decides the
    // build/convert route) and writes a plain PNG with no embedded
    // source. Rendering happens before the dialog, so a failure
    // never leaves a file behind.
    const exportPlainPngFromPanel = async (): Promise<void> => {
      const source = document.pendingSource ?? document.savedSource ?? '';
      const defaultName = document.kind === 'svg' ? `${documentStem()}.png` : `${documentStem()}.plain.png`;
      const deps = {
        ...createCorePlainPngDeps(await this.corePythonPath()),
        chooseTarget: async (defaultPath: string): Promise<string | null> => {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultPath),
            filters: { 'PNG images': ['png'] },
            saveLabel: 'Export PNG',
          });
          if (!target) return null;
          if (target.fsPath === document.uri.fsPath) {
            document.notifyNotice('Export PNG refused: the open document itself cannot be the export target.');
            return null;
          }
          return target.fsPath;
        },
        writeFile: async (path: string, bytes: Uint8Array): Promise<void> => {
          await vscode.workspace.fs.writeFile(vscode.Uri.file(path), bytes);
        },
      };
      const result = await exportPlainPng(deps, {
        source,
        width: document.width,
        height: document.height,
        defaultPath: join(dirname(document.uri.fsPath), defaultName),
      });
      if (result.status === 'exported') {
        const via = result.viaNormalization ? ' (rendered via normalization)' : '';
        void vscode.window.showInformationMessage(`Vector PNG: plain PNG exported${via}: ${result.targetPath}`);
        if (result.warnings.length > 0) {
          const shown = result.warnings.slice(0, 10).join('\n');
          const more = result.warnings.length > 10 ? `\n…and ${result.warnings.length - 10} more` : '';
          void vscode.window.showWarningMessage(`Normalization warnings:\n${shown}${more}`);
        }
      } else if (result.status === 'failed') {
        void vscode.window.showErrorMessage(`Vector PNG: plain PNG export failed (${result.stage}): ${result.message}`);
      }
    };

    const schemaProfile = loadSchemaProfile(this.extensionUri);
    const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const validation = validateWebviewMessage(raw);
      if (!validation.ok) return; // Bounded protocol: drop invalid messages.
      const message = validation.message;
      if (message.type === 'ready') {
        void panel.webview.postMessage({
          type: 'init',
          previewUri: savedUri(),
          meta: document.kind === 'svg'
            ? `${document.width} x ${document.height} SVG source`
            : `${document.width} x ${document.height} vector-png`,
          source: document.pendingSource ?? '',
          rootFill: readRootFill(document.pendingSource ?? ''),
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
        postRootFill();
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
      } else if (message.type === 'saveDocument') {
        // Route through VS Code so the custom document save lifecycle
        // (conflict handling, Core write) runs exactly as for Ctrl+S.
        void vscode.commands.executeCommand('workbench.action.files.save');
      } else if (message.type === 'formatSource') {
        const source = document.pendingSource ?? '';
        const formatted = formatSvgSource(source);
        if (formatted === source) document.notifyNotice('The source is already formatted.');
        else applyHostEdit(formatted, 'Format SVG source', 'format');
      } else if (message.type === 'applyRootFill') {
        const source = document.pendingSource ?? '';
        if (!isValidFillValue(message.value)) {
          postRootFill(); // Resync the field to the actual value.
          return;
        }
        const next = setRootFill(source, message.value);
        if (next === null) {
          document.notifyNotice('The root <svg> element could not be located, so its fill was not changed.');
          postRootFill();
          return;
        }
        // An unchanged result (re-applying the shown value) records
        // no edit; the field simply resyncs.
        if (next !== source) applyHostEdit(next, 'Set root fill', 'root-fill');
        postRootFill();
      } else if (message.type === 'copySource') {
        void vscode.env.clipboard.writeText(document.pendingSource ?? '')
          .then(() => document.notifyNotice('SVG source copied to the clipboard.'));
      } else if (message.type === 'exportSource') {
        void exportSourceToFile();
      } else if (message.type === 'exportPng') {
        void exportPlainPngFromPanel();
      }
    });
    panel.onDidDispose(() => {
      subscription.dispose();
      syncSubscription.dispose();
      savedSubscription.dispose();
      noticeSubscription.dispose();
      viewStateSubscription.dispose();
      preview.dispose();
      if (this.activeEditorPanel === panel) this.activeEditorPanel = undefined;
    });
  }

  // "Vector PNG: Toggle Word Wrap" (Alt+Z while this editor is the
  // active custom editor): the wrap state itself lives in the
  // webview, so the command just asks the active panel to toggle.
  toggleWordWrapOnActivePanel(): void {
    void this.activeEditorPanel?.webview.postMessage({ type: 'toggleWordWrap' });
  }

  async saveCustomDocument(document: VectorPngDocument, cancellation: vscode.CancellationToken): Promise<void> {
    const source = document.pendingSource;
    if (source === undefined) throw new Error('Nothing to save');
    // Set when the user explicitly resolved a conflict by overwriting:
    // the SVG text save then skips its revision-token guard (the PNG
    // save re-reads the token through the Core either way).
    let forceOverwrite = false;
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
        const target = await vscode.window.showSaveDialog({
          filters: document.kind === 'svg' ? { 'SVG': ['svg'] } : { 'Vector PNG': ['png'] },
          saveLabel: 'Save As',
        });
        if (!target) throw new Error('Save cancelled');
        await this.saveCustomDocumentAs(document, target, cancellation);
        return;
      }
      if (choice !== 'Overwrite the external change') throw new Error('Save cancelled');
      document.tracker.resolveOverwrite();
      forceOverwrite = true;
    }
    try {
      if (document.kind === 'svg') {
        // The .svg is its own source file: a plain UTF-8 text write,
        // guarded by the revision token unless the file was deleted
        // (recreate it) or the user resolved a conflict by overwriting.
        const expected = document.tracker.isDeleted || forceOverwrite ? undefined : document.tracker.agreedSha;
        await saveSvgTextFile(createNodeSvgSaveDeps(), document.uri.fsPath, source, expected);
      } else {
        const deps = createCoreSaveDeps(await this.corePythonPath());
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
      }
    } catch (error) {
      const label = document.kind === 'svg' && error instanceof SvgSaveConflictError
        ? 'Vector PNG save conflict'
        : 'Vector PNG save failed';
      void vscode.window.showErrorMessage(`${label}: ${error instanceof Error ? error.message : String(error)}`);
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
      if (document.kind === 'svg') {
        // The Save As dialog already confirmed any replacement.
        await saveSvgTextFile(createNodeSvgSaveDeps(), targetUri.fsPath, source, undefined);
      } else {
        await saveAs(createCoreSaveDeps(await this.corePythonPath()), targetUri.fsPath, {
          source, width: document.width, height: document.height,
          isCancelled: () => cancellation.isCancellationRequested,
        });
      }
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
    if (document.kind === 'svg') {
      const text = decodeSvgText(bytes);
      if (text === null) throw new Error('The file on disk is not valid UTF-8 text');
      document.savedSource = text;
      document.history.reset(text);
      document.tracker.noteReloaded(createHash('sha256').update(bytes).digest('hex'));
      document.syncSource(text);
      document.notifySaved();
      return;
    }
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

  // `Vector PNG: Export as Vector PNG` (Issue #47). The exported
  // source is the open document's current (possibly unsaved) source,
  // or the file's disk content when no editor is open for it; the
  // source file itself is never modified by an export.
  async exportAsVectorPng(target?: vscode.Uri): Promise<void> {
    const uri = target
      ?? this.activeCustomEditorUri()
      ?? vscode.window.activeTextEditor?.document.uri
      ?? (await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'SVG images': ['svg'] },
        openLabel: 'Export as Vector PNG',
      }))?.[0];
    if (!uri) return;
    const fileName = uri.path.split('/').pop() ?? uri.path;
    if (!isSvgFileName(fileName)) {
      void vscode.window.showErrorMessage(`Vector PNG export: ${fileName} is not an .svg file`);
      return;
    }
    const open = this.findOpenDocument(uri);
    let source: string;
    let width: number;
    let height: number;
    if (open?.kind === 'svg') {
      source = open.pendingSource ?? open.savedSource ?? '';
      width = open.width;
      height = open.height;
    } else {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        void vscode.window.showErrorMessage(`Vector PNG export: could not read ${fileName}`);
        return;
      }
      const text = decodeSvgText(bytes);
      if (text === null) {
        void vscode.window.showErrorMessage(`Vector PNG export: ${fileName} is not valid UTF-8 text within the editor source limit`);
        return;
      }
      source = text;
      const size = svgDocumentSize(text);
      width = size.width;
      height = size.height;
    }
    const targetPath = uri.fsPath.replace(/\.svg$/i, '.png');
    const deps = {
      ...createCoreExportDeps(await this.corePythonPath()),
      confirmOverwrite: async (path: string): Promise<boolean> => {
        const name = path.split('/').pop() ?? path;
        const choice = await vscode.window.showWarningMessage(
          `Vector PNG export: ${name} already exists. Replace it?`,
          { modal: true }, 'Overwrite');
        return choice === 'Overwrite';
      },
      presentDiagnostics: async (diagnostics: ProfileDiagnostic[]): Promise<'normalize' | 'cancel'> => {
        const summary = `${fileName} is not valid safe-svg-v1 (${diagnostics.length} diagnostic(s)). Nothing was written.`;
        const choice = await vscode.window.showErrorMessage(
          `Vector PNG export: ${summary}`,
          'Export via normalization', 'Show diagnostics');
        if (choice === 'Export via normalization') return 'normalize';
        if (choice === 'Show diagnostics') {
          const document = await vscode.workspace.openTextDocument({
            language: 'text',
            content: `safe-svg-v1 diagnostics for ${fileName}:\n\n${formatProfileDiagnostics(diagnostics)}\n`,
          });
          await vscode.window.showTextDocument(document, { preview: true });
          const again = await vscode.window.showErrorMessage(
            'Vector PNG export: export this file through normalization instead? The source file is not modified.',
            'Export via normalization');
          return again === 'Export via normalization' ? 'normalize' : 'cancel';
        }
        return 'cancel';
      },
    };
    const result = await exportSvgAsVectorPng(deps, { source, targetPath, width, height });
    if (result.status === 'exported') {
      const via = result.via === 'convert' ? ' (via normalization)' : '';
      void vscode.window.showInformationMessage(`Vector PNG exported${via}: ${result.targetPath}`);
      if (result.warnings.length > 0) {
        const shown = result.warnings.slice(0, 10).join('\n');
        const more = result.warnings.length > 10 ? `\n…and ${result.warnings.length - 10} more` : '';
        void vscode.window.showWarningMessage(`Normalization warnings for ${fileName}:\n${shown}${more}`);
      }
    } else if (result.status === 'cancelled-overwrite') {
      void vscode.window.showInformationMessage('Vector PNG export cancelled: the existing PNG was left unchanged.');
    } else if (result.status === 'failed') {
      void vscode.window.showErrorMessage(`Vector PNG export failed (${result.stage}): ${result.message}`);
    }
    // status 'invalid': the diagnostics were already presented by the
    // presentDiagnostics callback; nothing further to report.
  }

  private activeCustomEditorUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE ? input.uri : undefined;
  }

  // `Vector PNG: Normalize SVG` (Issue #47 follow-up). An explicit,
  // deliberate operation on an open `.svg` document - never a step of
  // open, save or export. An unopened `.svg` is opened in the editor
  // first; files are never rewritten behind the editor's back. The
  // normalized source lands as an ordinary undoable edit (dirty until
  // the user saves), so the document model - history, conflict
  // protection, save flow - is never bypassed.
  async normalizeSvg(target?: vscode.Uri): Promise<void> {
    const uri = target
      ?? this.activeCustomEditorUri()
      ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showInformationMessage('Vector PNG: open an SVG document in the editor to normalize it.');
      return;
    }
    let document = this.findOpenDocument(uri);
    if (!document) {
      if (!isSvgFileName(uri.path.split('/').pop() ?? '')) {
        void vscode.window.showInformationMessage('Vector PNG: Normalize SVG applies to .svg documents in this editor.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      document = this.findOpenDocument(uri);
      if (!document) {
        void vscode.window.showErrorMessage('Vector PNG: could not open the SVG document to normalize it.');
        return;
      }
    }
    if (document.kind !== 'svg') {
      void vscode.window.showInformationMessage('Vector PNG: Normalize SVG applies to .svg documents; this is a vector-png document.');
      return;
    }
    const source = document.pendingSource ?? document.savedSource ?? '';
    const result = await normalizeSourceText(createCoreNormalizeDeps(await this.corePythonPath()), source);
    if (result.status === 'already-normalized') {
      void vscode.window.showInformationMessage('Vector PNG: this SVG is already in normalized safe-svg-v1 form; no changes were made.');
      return;
    }
    if (result.status === 'failed') {
      const headline = `Vector PNG normalize failed (${result.code}): ${result.message}. The document was not changed.`;
      if (result.errors.length === 0) {
        void vscode.window.showErrorMessage(headline);
        return;
      }
      const choice = await vscode.window.showErrorMessage(headline, 'Show diagnostics');
      if (choice === 'Show diagnostics') {
        const doc = await vscode.workspace.openTextDocument({
          language: 'text',
          content: `Normalization failure for ${uri.path.split('/').pop() ?? 'document'}:\n\n${formatNormalizeErrors(result.errors)}\n`,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
      return;
    }
    if (!applyNormalizedEdit(document, result.source)) {
      void vscode.window.showInformationMessage('Vector PNG: this SVG is already in normalized safe-svg-v1 form; no changes were made.');
      return;
    }
    // Fire the edit event so VS Code's undo stack tracks the change;
    // the closures only move the history pointer, like webview edits.
    const applyPointer = (source: string | undefined) => {
      if (source !== undefined) document.syncSource(source);
    };
    const edit: VectorPngEdit = {
      label: 'Normalize SVG',
      undo: async () => applyPointer(document.history.undo()),
      redo: async () => applyPointer(document.history.redo()),
    };
    this.changeEmitter.fire({ document, ...edit });
    void vscode.window.showInformationMessage(
      `Vector PNG: SVG normalized (${formatNormalizeSummary(result.summary)}). The change is unsaved and can be undone.`);
    if (result.summary.losses.length > 0) {
      const shown = result.summary.losses.slice(0, 10).join('\n');
      const more = result.summary.losses.length > 10 ? `\n…and ${result.summary.losses.length - 10} more` : '';
      void vscode.window.showWarningMessage(`Normalization recorded losses:\n${shown}${more}`);
    }
  }
}


async function openInEditor(target?: vscode.Uri): Promise<void> {
  const uri = target ?? vscode.window.activeTextEditor?.document.uri
    ?? (await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'PNG and SVG images': ['png', 'svg'] },
      openLabel: 'Open in Vector PNG Editor',
    }))?.[0];
  if (!uri) return;
  const bytes = await vscode.workspace.fs.readFile(uri);
  const route = routeForFile(detectPng(bytes), uri.path.split('/').pop() ?? uri.path);
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
  const provider = new VectorPngEditorProvider(context.extensionUri, context.globalStorageUri, context.extensionPath, managedRoot);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('vectorPng.openInEditor', openInEditor),
    vscode.commands.registerCommand('vectorPng.exportAsVectorPng', (target?: vscode.Uri) => provider.exportAsVectorPng(target)),
    vscode.commands.registerCommand('vectorPng.normalizeSvg', (target?: vscode.Uri) => provider.normalizeSvg(target)),
    vscode.commands.registerCommand('vectorPng.newDocument', newDocument),
    vscode.commands.registerCommand('vectorPng.setupEnvironment', () => setupEnvironment(context, managedRoot)),
    vscode.commands.registerCommand('vectorPng.toggleWordWrap', () => provider.toggleWordWrapOnActivePanel()),
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
