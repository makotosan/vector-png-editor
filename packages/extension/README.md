# Vector PNG Editor extension

VS Code extension package for vector-png files: PNG images that carry their
SVG source in a single compressed `iTXt` chunk with the keyword
`vector-png.svg` (wire v1).

## P2-02: secure Webview and Monaco

The webview loads Monaco only from packaged local assets. Run
`npm run bundle:monaco` (also wired as `vscode:prepublish`) to copy the
pinned `monaco-editor` package into `media/monaco/`; that directory is
generated and not committed. The page shell carries a restrictive CSP
(`default-src 'none'`, `connect-src 'none'`, nonce-bound scripts, packaged
workers), contains no user content, and receives the SVG source by
message into a Monaco model. Completion and advisory diagnostics follow
the safe-svg-v1 allowlists in `src/profile.ts`, which a unit test checks
against the Python Core. Messages from the webview are schema-checked
and bounded in `src/messages.ts`.

## P2-01 scope: registration and open routing

- Registers the custom editor view type `vectorPng.editor` for `*.png` with
  priority `option`, so ordinary PNGs keep opening in the standard image
  viewer and the editor never hijacks all PNG files.
- `Vector PNG: Open in Editor` inspects the file structure and routes it:
  valid vector-png files open in the custom editor, ordinary PNGs open in
  the default viewer, and malformed vector-png files show a diagnostic
  instead of silently falling back.
- Detection (`src/detect.ts`) is passive and structural only. It walks PNG
  chunks with bounds and CRC checks and looks for the source chunk; it
  never decompresses, parses or executes the embedded SVG. Full container,
  profile and preview validation stays with the Python Core.
- `Vector PNG: New Document` creates a 1024x1024 fully transparent
  vector-png document whose embedded source is a minimal safe-svg-v1
  document, generated programmatically in `src/newDocument.ts`.
- The routing decision (`src/routing.ts`) and detection are pure TypeScript
  with no VS Code dependency, following the bridge package's convention of
  running TypeScript directly under Node's test runner.

The provider remains read-only at the VS Code level: the webview shows
the saved PNG raster next to the Monaco source model, edits update
advisory diagnostics in memory, and nothing is written back yet.
Previews (P2-03) and the editable save lifecycle (P2-04) replace the
read-only provider without changing the view type or commands.
Compilation/bundling for VSIX distribution is P3-04 scope; `npm run check`
type-checks the sources.

## Tests

```sh
npm install
npm run check   # TypeScript type check
npm test        # node --test: detection, routing and new-document suites
```

Extension-host command tests run in the VS Code test host as part of the
P3 acceptance work; the unit suites above cover the same routing decisions
the commands execute.
