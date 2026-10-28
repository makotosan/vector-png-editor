# Extension implementation — P2-01

[日本語](EXTENSION_PROGRESS.ja.md)

## Delivered scope

P2-01 adds `packages/extension`, a TypeScript VS Code extension package that
registers the `vectorPng.editor` custom editor for `*.png` with priority
`option`, the `Vector PNG: Open in Editor` command with structural open
routing, and `Vector PNG: New Document` for new 1024x1024 transparent
documents. Ordinary PNGs route to the standard image viewer, malformed
vector-png files produce a diagnostic, and detection never decompresses,
parses or executes the embedded SVG. The editor registered in this phase is
read-only and shows the saved PNG raster in a script-disabled webview under
a restrictive CSP; no SVG is inserted into the DOM.

## Verification

Node 24 unit suites cover detection (ordinary, valid, keyword in the wrong
text chunk, duplicate source chunks, uncompressed source, bad CRC,
truncation, non-PNG), routing for all four detection outcomes, and the new
document (dimensions, fully transparent raster, embedded source roundtrip):
15 tests passed locally. `tsc` type checking passed with the pinned
TypeScript 5.9.3 and VS Code 1.90 API types. As a cross-check, the Python
Core's own `inspect` accepted a generated new document as a valid wire v1
container (1024x1024, colour type 6, 73-byte source).

## Remaining work

Extension-host command tests have not run yet; they belong to the P3
acceptance work and the unit suites cover the same routing logic the
commands call. Monaco source editing is P2-02, previews are P2-03, and the
editable CustomDocument save/undo lifecycle is P2-04/P2-05; those phases
replace the read-only provider without changing the view type, commands or
routing. VSIX compilation and bundling are P3-04 scope. P2-01 therefore
remains open until extension-host evidence exists; this document does not
close it.

## Webview and Monaco follow-up — P2-02

The editor webview now loads Monaco 0.57.0 only from packaged local assets
(`media/monaco`, copied from the pinned npm package by
`scripts/copy-monaco.mjs`; the generated bundle is not committed). The page
shell is produced by `src/webviewHtml.ts` and contains no user content: the
SVG source arrives by message and lives in a Monaco text model, never in
the DOM. The CSP sets `default-src 'none'` and `connect-src 'none'`, limits
scripts to a nonce plus packaged resources, and lets workers run only from
packaged resources or blobs, so the packaged editor works offline and the
source cannot trigger network access.

Webview messages are validated by `src/messages.ts` (known types only,
bounded source size, integer revisions). Source extraction for editing is
in `src/extract.ts`: bounded decompression that preserves exact bytes,
including BOM and newline style. Completion and advisory diagnostics use
the safe-svg-v1 allowlists in `src/profile.ts`; a unit test parses the
Python Core's `_backend.py` and fails if the lists drift. Diagnostics are
advisory only - the Core validator remains authoritative.

Local verification: 34 extension unit tests passed (the 15 from P2-01 plus
extraction, message validation, profile parity, hostile-source diagnostics
and CSP/asset checks) and the TypeScript type check passed. Extension-host
and packaged-VSIX offline tests have not run yet; they remain part of the
P3 acceptance work, so P2-02 stays open until that evidence exists. The
editor model accepts edits and updates diagnostics, but persistence is
still not wired: preview rendering is P2-03 and saving is P2-04.

## Debounced previews and manual toggle — P2-03

Edited previews are produced only by the Python Core. `src/preview.ts` is
a framework-free controller: it renders after 300 ms idle, gives every
schedule a generation, and discards any result that finishes after a
newer edit was scheduled, so the latest source always wins even when
workers finish out of order. `src/corePreview.ts` validates the edited
source through the bridge package's `LatestValidation` lane and only
then renders it with the Core `build` command into a private preview
file; an invalid source is rejected before any rendering and is never
shown. The preview file is never the user's document.

The preview pane opens on the actual saved raster. Switching between
"Saved PNG" and "Edited SVG" is manual only: `webview/preview-state.js`
changes mode exclusively from the toggle buttons, and arriving preview
results refresh the edited image without ever switching the mode. There
is no automatic image diff or auto toggle.

The Core is reached through the new `vectorPng.corePythonPath` setting
(a Python 3.11-3.13 with the Core installed). Until the managed
environment integration lands, an unset path makes edited previews
report themselves unavailable while the saved preview keeps working.

Local verification: 46 extension unit tests passed with a real Core
(44 passed and 2 Core-integration tests skipped without one), covering
fake-timer debounce, rapid edits, out-of-order completion, stale error
dropping, hostile-source rejection by the real Core validator, the
no-auto-toggle invariant and saved-raster fidelity; the TypeScript type
check passed. Extension-host and packaged-VSIX tests remain P3
acceptance work, so P2-03 stays open until that evidence exists.
