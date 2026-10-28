// Vector PNG editor webview. Loaded only from the packaged local Monaco
// bundle; the page contains no user SVG. The source arrives by message and
// lives in a Monaco text model - it is never inserted into the DOM.
'use strict';
const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('vpe-config').textContent);

let editor = null;
let monacoRef = null;
let profile = { elements: [], attributes: [] };
const previewState = window.VpePreviewState.createPreviewState();
let savedUri = '';

function refreshPreview() {
  const img = document.getElementById('preview');
  const uri = previewState.visibleUri(savedUri);
  if (uri && img.getAttribute('src') !== uri) img.src = uri;
  document.getElementById('show-saved').setAttribute('aria-pressed', String(previewState.mode === 'saved'));
  document.getElementById('show-edited').setAttribute('aria-pressed', String(previewState.mode === 'edited'));
  const status = document.getElementById('preview-status');
  status.textContent = previewState.mode === 'edited'
    ? (previewState.editedError ?? (previewState.editedUri ? '' : 'No edited preview yet.'))
    : '';
}
document.getElementById('show-saved').addEventListener('click', () => {
  previewState.showSaved();
  vscode.postMessage({ type: 'setPreviewMode', mode: 'saved' });
  refreshPreview();
});
document.getElementById('show-edited').addEventListener('click', () => {
  previewState.showEdited();
  vscode.postMessage({ type: 'setPreviewMode', mode: 'edited' });
  refreshPreview();
});
let revision = 0;
let applyingHostUpdate = false;

self.MonacoEnvironment = {
  // All workers resolve to the locally packaged editor worker. The XML
  // language used here needs no separate language worker.
  getWorkerUrl: () => config.workerUri,
};

require.config({ paths: { vs: config.monacoVs } });
require(['vs/editor/editor.main'], (monaco) => {
  monacoRef = monaco;
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: '',
    language: 'xml',
    automaticLayout: true,
    minimap: { enabled: false },
    // Editing is enabled so completion and diagnostics can be exercised;
    // persistence is wired in P2-04 and preview rendering in P2-03.
    readOnly: false,
  });

  monaco.languages.registerCompletionItemProvider('xml', {
    triggerCharacters: ['<', ' '],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const inTag = /<[^>]*$/.test(line);
      const items = inTag && /\s[^<]*$/.test(line)
        ? profile.attributes.map(a => ({ label: a, kind: monaco.languages.CompletionItemKind.Property, insertText: `${a}="$0"`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range }))
        : profile.elements.map(e => ({ label: e, kind: monaco.languages.CompletionItemKind.Class, insertText: e, range }));
      return { suggestions: items };
    },
  });

  editor.onDidChangeModelContent(() => {
    if (applyingHostUpdate || !editor) return;
    revision += 1;
    vscode.postMessage({ type: 'sourceChanged', revision, source: editor.getValue() });
  });

  vscode.postMessage({ type: 'ready' });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    profile = { elements: message.elements ?? [], attributes: message.attributes ?? [] };
    savedUri = message.previewUri;
    refreshPreview();
    document.getElementById('meta').textContent = message.meta;
    if (editor && editor.getValue() !== message.source) {
      applyingHostUpdate = true;
      editor.setValue(message.source);
      applyingHostUpdate = false;
    }
  } else if (message.type === 'notice') {
    document.getElementById('meta').textContent = message.text;
  } else if (message.type === 'saved') {
    savedUri = message.previewUri;
    refreshPreview();
  } else if (message.type === 'sourceSync') {
    if (editor && editor.getValue() !== message.source) {
      applyingHostUpdate = true;
      editor.setValue(message.source);
      applyingHostUpdate = false;
    }
  } else if (message.type === 'previewRendered') {
    previewState.editedRendered(message.uri, message.revision);
    refreshPreview();
  } else if (message.type === 'previewInvalid') {
    previewState.editedInvalid(`Edited preview unavailable: ${message.message}`);
    refreshPreview();
  } else if (message.type === 'previewUnavailable') {
    previewState.editedInvalid(message.message);
    refreshPreview();
  } else if (message.type === 'diagnostics' && editor) {
    if (!monacoRef) return;
    const markers = message.diagnostics.map(d => ({
      severity: 4, // MarkerSeverity.Warning
      message: d.message,
      startLineNumber: d.line + 1,
      startColumn: d.column + 1,
      endLineNumber: d.line + 1,
      endColumn: d.column + 1 + Math.max(1, d.length),
    }));
    monacoRef.editor.setModelMarkers(editor.getModel(), 'safe-svg-v1', markers);
  }
});
