// Vector PNG editor webview. Loaded only from the packaged local Monaco
// bundle; the page contains no user SVG. The source arrives by message and
// lives in a Monaco text model - it is never inserted into the DOM.
'use strict';
const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('vpe-config').textContent);

let editor = null;
let monacoRef = null;
let profile = { elements: [], attributes: [], children: {}, textElements: [] };

// The innermost element still open at the start of `text` (the model
// text before the cursor), or null at the top level. Text scan only -
// never a DOM - matching the extension's diagnostics approach.
function enclosingElement(text) {
  const stack = [];
  const tagPattern = /<(\/?)([A-Za-z][A-Za-z0-9._-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
  for (const match of text.matchAll(tagPattern)) {
    if (match[1] === '/') {
      if (stack[stack.length - 1] === match[2]) stack.pop();
    } else if (match[4] !== '/') {
      stack.push(match[2]);
    }
  }
  return stack.length ? stack[stack.length - 1] : null;
}

function elementSuggestions(model, position) {
  const offset = model.getOffsetAt(position);
  const parent = enclosingElement(model.getValue().slice(0, offset));
  const allowed = parent !== null && Array.isArray(profile.children[parent])
    ? profile.children[parent]
    : profile.elements;
  return allowed;
}
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
  persistPanelState();
  refreshPreview();
});
document.getElementById('show-edited').addEventListener('click', () => {
  previewState.showEdited();
  vscode.postMessage({ type: 'setPreviewMode', mode: 'edited' });
  persistPanelState();
  refreshPreview();
});

// --- Code toolbar and Preview panel (Issue #45) ---
// Panel choices persist per panel in the webview state: the preview
// mode and the background survive a hide/reveal of the panel. The
// FILL value is not panel state - it always mirrors the source and
// arrives from the host.
const persistedPanel = vscode.getState() ?? {};
if (persistedPanel.previewMode === 'edited') previewState.showEdited();
previewState.setBackgroundPreset(typeof persistedPanel.backgroundPreset === 'string' ? persistedPanel.backgroundPreset : 'checkerboard');
if (typeof persistedPanel.customColor === 'string') previewState.setBackgroundCustom(persistedPanel.customColor);
if (previewState.mode !== 'saved') vscode.postMessage({ type: 'setPreviewMode', mode: previewState.mode });
// Word wrap for the code pane (Issue #45 follow-up): off by default,
// toggled by Alt+Z or the toolbar Wrap button, persisted per panel
// like the other panel choices. The editor picks the value up at
// creation and on every toggle.
let wordWrapOn = persistedPanel.wordWrap === true;
function persistPanelState() {
  vscode.setState({
    previewMode: previewState.mode,
    backgroundPreset: previewState.backgroundPreset,
    customColor: previewState.customColor,
    wordWrap: wordWrapOn,
  });
}
function refreshWordWrap() {
  // Null-safe: a webview page retained across an extension upgrade
  // can predate the Wrap button; the script must degrade, not die.
  const button = document.getElementById('tool-wrap');
  if (button) button.setAttribute('aria-pressed', String(wordWrapOn));
  if (editor) editor.updateOptions({ wordWrap: wordWrapOn ? 'on' : 'off' });
}
function toggleWordWrap() {
  wordWrapOn = !wordWrapOn;
  refreshWordWrap();
  persistPanelState();
}
const wrapButton = document.getElementById('tool-wrap');
if (wrapButton) wrapButton.addEventListener('click', toggleWordWrap);
// Capture phase, so the toggle fires exactly once even when Monaco
// has focus (and regardless of any binding Monaco itself may have);
// holding the keys down does not strobe the setting.
document.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyZ') return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) toggleWordWrap();
}, true);
refreshWordWrap();

function refreshBackground() {
  const area = document.getElementById('preview-area');
  const value = previewState.backgroundValue();
  area.classList.toggle('checkerboard', value === 'checkerboard');
  area.style.backgroundColor = value === 'checkerboard' ? '' : value;
  for (const preset of ['checkerboard', 'white', 'black']) {
    document.getElementById('bg-' + preset).setAttribute('aria-pressed',
      String(previewState.customColor === null && previewState.backgroundPreset === preset));
  }
  document.getElementById('background-swatch').value =
    previewState.customColor ?? (previewState.backgroundPreset === 'black' ? '#000000' : '#ffffff');
}
for (const preset of ['checkerboard', 'white', 'black']) {
  document.getElementById('bg-' + preset).addEventListener('click', () => {
    previewState.setBackgroundPreset(preset);
    const text = document.getElementById('background-text');
    text.value = '';
    text.removeAttribute('aria-invalid');
    refreshBackground();
    persistPanelState();
  });
}
const backgroundText = document.getElementById('background-text');
document.getElementById('background-swatch').addEventListener('input', (event) => {
  previewState.setBackgroundCustom(event.target.value);
  backgroundText.value = previewState.customColor ?? '';
  backgroundText.removeAttribute('aria-invalid');
  refreshBackground();
  persistPanelState();
});
backgroundText.addEventListener('input', () => backgroundText.removeAttribute('aria-invalid'));
backgroundText.addEventListener('change', () => {
  const raw = backgroundText.value.trim();
  if (raw === '') {
    // Clearing the field clears the custom colour, back to the
    // checkerboard preset.
    previewState.setBackgroundPreset('checkerboard');
    backgroundText.removeAttribute('aria-invalid');
  } else {
    const normalized = window.VpePreviewState.normalizeHexColor(raw);
    if (!normalized) {
      // Rejected: restore the last valid value and mark the field
      // invalid; the background itself never changes on bad input.
      backgroundText.value = previewState.customColor ?? '';
      backgroundText.setAttribute('aria-invalid', 'true');
      return;
    }
    previewState.setBackgroundCustom(normalized);
    backgroundText.value = normalized;
    backgroundText.removeAttribute('aria-invalid');
  }
  refreshBackground();
  persistPanelState();
});

// FILL row: mirrors the root element's fill attribute. Nothing is
// applied while typing or picking - only Enter / Apply posts the
// value, and the host turns it into one ordinary document edit.
// While the field is focused or dirty, host refreshes (typing in
// Monaco, undo, sync) are deferred and land on blur, so an edit in
// progress is never overwritten mid-keystroke.
let fillFieldDirty = false;
let deferredFill = null;
function showRootFill(value) {
  const text = document.getElementById('fill-text');
  text.value = value;
  const hex = window.VpePreviewState.normalizeHexColor(value);
  if (hex) document.getElementById('fill-swatch').value = hex;
}
function refreshRootFill(available, value) {
  const row = document.getElementById('fill-row');
  for (const id of ['fill-swatch', 'fill-text', 'fill-apply'])
    document.getElementById(id).disabled = !available;
  row.title = available ? '' : 'The root <svg> element could not be located in the source, so its fill cannot be edited here.';
  if (!available) return;
  if (fillFieldDirty || document.activeElement === document.getElementById('fill-text')) {
    deferredFill = value;
    return;
  }
  showRootFill(value);
}
const fillText = document.getElementById('fill-text');
fillText.addEventListener('input', () => { fillFieldDirty = true; });
fillText.addEventListener('blur', () => {
  fillFieldDirty = false;
  if (deferredFill !== null) { showRootFill(deferredFill); deferredFill = null; }
});
document.getElementById('fill-swatch').addEventListener('input', (event) => {
  // Picking a colour only fills the field; Apply still decides.
  fillText.value = event.target.value;
  fillFieldDirty = true;
});
function applyRootFill() {
  vscode.postMessage({ type: 'applyRootFill', value: fillText.value });
  fillFieldDirty = false;
  deferredFill = null;
}
document.getElementById('fill-apply').addEventListener('click', applyRootFill);
fillText.addEventListener('keydown', (event) => { if (event.key === 'Enter') applyRootFill(); });

document.getElementById('tool-save').addEventListener('click', () => vscode.postMessage({ type: 'saveDocument' }));
document.getElementById('tool-format').addEventListener('click', () => vscode.postMessage({ type: 'formatSource' }));
document.getElementById('action-copy').addEventListener('click', () => vscode.postMessage({ type: 'copySource' }));
document.getElementById('action-export').addEventListener('click', () => vscode.postMessage({ type: 'exportSource' }));
document.getElementById('action-export-png').addEventListener('click', () => vscode.postMessage({ type: 'exportPng' }));
refreshBackground();
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
  // Follow the VS Code colour theme (design B, Issue #45): VS Code
  // marks the webview body with its theme class, and the page chrome
  // already follows it through the --vscode-* variables. Give Monaco
  // the matching built-in theme and keep it in step when the class
  // changes (a theme switch does not reload the webview).
  const syncMonacoTheme = () => {
    monaco.editor.setTheme(document.body.classList.contains('vscode-dark') ||
      document.body.classList.contains('vscode-high-contrast')
      ? 'vs-dark' : 'vs');
  };
  syncMonacoTheme();
  new MutationObserver(syncMonacoTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: '',
    language: 'xml',
    wordWrap: wordWrapOn ? 'on' : 'off',
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
        : elementSuggestions(model, position).map(e => ({ label: e, kind: monaco.languages.CompletionItemKind.Class, insertText: e, range }));
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
    profile = {
      elements: message.elements ?? [],
      attributes: message.attributes ?? [],
      children: message.children ?? {},
      textElements: message.textElements ?? [],
    };
    savedUri = message.previewUri;
    refreshPreview();
    refreshBackground();
    if (message.rootFill) refreshRootFill(message.rootFill.available === true, typeof message.rootFill.value === 'string' ? message.rootFill.value : '');
    document.getElementById('meta').textContent = message.meta;
    if (editor && editor.getValue() !== message.source) {
      applyingHostUpdate = true;
      editor.setValue(message.source);
      applyingHostUpdate = false;
    }
  } else if (message.type === 'rootFill') {
    refreshRootFill(message.available === true, typeof message.value === 'string' ? message.value : '');
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
