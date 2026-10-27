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
