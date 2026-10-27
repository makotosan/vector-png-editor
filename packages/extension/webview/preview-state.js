// Preview pane state for the webview. Pure logic, no DOM access, so it
// can be unit-tested outside the webview.
//
// Invariant (P2-03): the mode changes ONLY through showSaved/showEdited,
// which are wired to the user's toggle buttons. Arriving preview results
// never change the mode - there is no automatic toggle. The saved mode
// always shows the actual saved raster.
(function (global) {
  'use strict';
  function createPreviewState() {
    let mode = 'saved';
    let editedUri = null;
    let editedRevision = -1;
    let editedError = null;
    return {
      get mode() { return mode; },
      get editedUri() { return editedUri; },
      get editedRevision() { return editedRevision; },
      get editedError() { return editedError; },
      showSaved() { mode = 'saved'; },
      showEdited() { mode = 'edited'; },
      editedRendered(uri, revision) {
        editedUri = uri;
        editedRevision = revision;
        editedError = null;
      },
      editedInvalid(message) { editedError = message; },
      visibleUri(savedUri) { return mode === 'edited' ? editedUri : savedUri; },
    };
  }
  global.VpePreviewState = { createPreviewState };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createPreviewState };
})(typeof window !== 'undefined' ? window : globalThis);
