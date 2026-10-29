// Preview pane state for the webview. Pure logic, no DOM access, so it
// can be unit-tested outside the webview.
//
// The two modes are labelled "PNG" and "Editing" in the UI (user
// decision, 2026-10-29): the 'saved' mode shows the PNG image the
// file itself holds, and the 'edited' mode shows the live render of
// the source being edited. The pane opens on Editing. The mode
// changes ONLY through showSaved/showEdited, which are wired to the
// user's toggle buttons - arriving preview results never change the
// mode. For an SVG document the PNG mode is unavailable (an SVG file
// holds no PNG image) and the webview disables its button.
//
// The same object also carries the Preview panel's background choice
// (Issue #45): one of the checkerboard/white/black presets or a custom
// colour. The background is pure presentation - it never reaches the
// source or the file - and editor.js persists it with the rest of the
// webview state so a panel keeps its look across reveals.
(function (global) {
  'use strict';
  // Accepts #rgb or #rrggbb (any case, optional surrounding space)
  // and returns the normalized lowercase #rrggbb, or null for
  // anything else - the BACKGROUND field rejects it and keeps the
  // last valid value.
  function normalizeHexColor(value) {
    if (typeof value !== 'string') return null;
    const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
    if (!match) return null;
    let hex = match[1].toLowerCase();
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    return '#' + hex;
  }
  function createPreviewState() {
    let mode = 'edited';
    let editedUri = null;
    let editedRevision = -1;
    let editedError = null;
    let backgroundPreset = 'checkerboard';
    let customColor = null;
    return {
      get mode() { return mode; },
      get editedUri() { return editedUri; },
      get editedRevision() { return editedRevision; },
      get editedError() { return editedError; },
      get backgroundPreset() { return backgroundPreset; },
      get customColor() { return customColor; },
      showSaved() { mode = 'saved'; },
      showEdited() { mode = 'edited'; },
      editedRendered(uri, revision) {
        editedUri = uri;
        editedRevision = revision;
        editedError = null;
      },
      editedInvalid(message) { editedError = message; },
      visibleUri(savedUri) { return mode === 'edited' ? editedUri : savedUri; },
      // Choosing a preset clears the custom colour and choosing a
      // custom colour deselects the presets: exactly one background
      // is ever in effect.
      setBackgroundPreset(preset) {
        if (preset === 'checkerboard' || preset === 'white' || preset === 'black') {
          backgroundPreset = preset;
          customColor = null;
        }
        return backgroundPreset;
      },
      setBackgroundCustom(color) {
        const normalized = normalizeHexColor(color);
        if (normalized) customColor = normalized;
        return customColor;
      },
      // The CSS background for the preview area: the custom colour
      // when one is set, else the preset's colour. The checkerboard
      // preset reports 'checkerboard' and CSS paints the pattern.
      backgroundValue() {
        if (customColor) return customColor;
        if (backgroundPreset === 'white') return '#ffffff';
        if (backgroundPreset === 'black') return '#000000';
        return 'checkerboard';
      },
    };
  }
  global.VpePreviewState = { createPreviewState, normalizeHexColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createPreviewState, normalizeHexColor };
})(typeof window !== 'undefined' ? window : globalThis);
