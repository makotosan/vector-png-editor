# Vector PNG Editor extension

VS Code extension package for vector-png files: PNG images that carry their
SVG source in a single compressed `iTXt` chunk with the keyword
`vector-png.svg` (wire v1).

## P2-07: Python discovery and managed environment

Three commands integrate the bridge managed-environment manager
(P1-04): **Set Up Python Environment** discovers a user Python
3.11-3.13 (read-only probes; a miss is explained with install
guidance), locates trusted Core artifacts (setting, bundled
`managed/` wheel, or a sibling checkout), confirms any network use,
and runs the manager with progress and cancellation - failures keep
the previously active environment. **Python Environment Status** and
**Roll Back Python Environment** report and roll back. Python
resolution is: the `vectorPng.corePythonPath` setting, else the
managed environment's active interpreter.

Since Issue #58 previews, saving, profile validation and the
export build route run in-process on the TypeScript Core
(packages/ts-core), and since Issue #59 so do **Normalize SVG**
and the normalization (`convert`) route of the exports: no editor
feature needs the Python environment any more. The setup commands
themselves retire in Phase 3 (Issue #60).

## P2-06: external change conflicts

Each document tracks the SHA-256 of the file bytes it last agreed
with (`src/watch.ts`). A file watcher classifies every disk change by
content, not timing - so the echo of our own save is ignored. An
external change to a clean document reloads it; a change to a dirty
document (or unreadable content, or a deletion) preserves the buffer,
notifies the user, and blocks the next save behind an explicit choice:
reload from disk, overwrite the external change, or Save As. Deleting
the file under a dirty document lets save recreate it. The save-time
revision token (P2-04) remains the second line of defense against a
change that lands between observation and save.

## P2-05: undo/redo synchronization and recovery

`src/history.ts` is the single authoritative history for a document.
Webview edits are recorded once there (typing bursts coalesce within
one second); identical re-deliveries of a host sync record nothing, so
undo/redo cannot feedback-loop. The edit events VS Code receives carry
undo/redo closures that only move the history pointer and sync the
snapshot to all panels. Saving never clears the history, so undo
across a save restores the pre-edit source and dirtiness is always
`current !== savedSource`. Revert and backup-restore reset the history
to the restored snapshot. Multiple editor panels per document are
enabled and kept in step through the same sync path. Backups
(`src/backup.ts`) copy the file plus a JSON sidecar with the pending
source, so hot-exit restore reopens with unsaved edits byte-exact.

## P2-04: source-preserving save and Save As

The editor is now a full `CustomEditorProvider`. Saving never writes
bytes directly: the host sends the edited source through the Core
`build` path with the file's current SHA-256 as the revision token.
The Core validates the profile, renders, verifies the candidate and
publishes atomically, retaining a backup snapshot; a profile violation
blocks the save, a changed destination is a conflict, and any failure
leaves the original file and the dirty buffer untouched. Source bytes
are preserved exactly (BOM, CRLF, formatting) because the source is
never reserialized. Save As creates a new file, or overwrites an
existing one only under that file's own token. Revert reloads from
disk; backups copy the file plus a small sidecar with the pending
source for hot-exit restore. Undo/redo events are emitted per edit;
with history synchronization handled in P2-05. Since Issue #58 the
`build` path is the TypeScript Core in-process (`src/tsCore.ts`),
mirroring the same validate/render/verify/publish discipline; the
Python bridge build is no longer used for saving.

## P2-03: debounced previews and manual toggle

Edited previews render in-process through the TypeScript Core
(Issue #58): after 300 ms idle the host validates the edited source
with ts-core and, only on success, renders it with resvg; the PNG
reaches the webview as a data URI and no preview file is ever
written. Stale results are discarded by generation, so the latest
source wins. The preview pane opens on the actual saved raster and
switches to the edited preview only when the user clicks the
toggle - never automatically. No Python environment is involved;
fonts are the host's system fonts, loaded once per activation
(`src/hostFonts.ts`, the interim strategy pending Issue #61).

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
  chunks with bounds and CRC checks - the TypeScript Core's container
  walk - and looks for the source chunk; it never decompresses, parses
  or executes the embedded SVG. Full container, profile and preview
  validation stays with the Core (the TypeScript Core in-process
  since Issue #58).
- `Vector PNG: New Document` creates a 1024x1024 fully transparent
  vector-png document whose embedded source is a minimal safe-svg-v1
  document, generated programmatically in `src/newDocument.ts`.
- The routing decision (`src/routing.ts`) and detection are pure TypeScript
  with no VS Code dependency, following the bridge package's convention of
  running TypeScript directly under Node's test runner.

The view type and commands have not changed since P2-01.
Compilation/bundling for VSIX distribution is P3-04 scope; `npm run check`
type-checks the sources.

## Editor UI: buttons by document kind

The split editor (Issues #44–#47) shows the same controls for every
editable document, but several behave differently per kind. A plain
PNG opens in a view-only page instead (Issue #46): no buttons at all,
just the image centred on a checkerboard, and the file is never
modified. The preview pane opens on the **Editing** view for both
editable kinds.

| Control | vector-png | SVG |
|---|---|---|
| Save | The TypeScript Core rebuilds the PNG from the source in-process (no Python needed; a source that fails validation is not saved and the file is unchanged) | The text is written back byte-exact under a SHA-256 guard (no Core needed; never blocked by validation) |
| Format | Applies the indentation-only formatter as one edit | Same |
| Wrap | Toggles Monaco word wrap (also Alt+Z / the Toggle Word Wrap command; persisted per panel) | Same |
| Background presets / BACKGROUND | Preview presentation only; never touches the source or the file | Same (the view-only page has a fixed checkerboard instead) |
| FILL + Apply | Edits the root `<svg>` `fill` as one undoable edit on Apply; the row is disabled when no root element can be located | Same |
| PNG (preview toggle) | Shows the raster image stored in the file | Disabled (greyed out): an SVG file holds no PNG image |
| Editing (preview toggle) | The current source rendered by the TypeScript Core in-process (no Python needed; a profile-invalid source shows the failure instead) | The current text rendered in place (no Core needed; never blocked by validation) |
| Copy SVG (code toolbar, beside Wrap) | Copies the current source text | Same |
| Export SVG | Saves the current source as `.svg` (default name `<base>.svg`) | Same (default name `<base>-copy.svg`) |
| Export Plain PNG | Saves a plain PNG with no embedded source (default `<base>.plain.png`; rendered by the TypeScript Core; a non-conforming source renders via normalization - also the TypeScript Core - and says so) | Same (default `<base>.png`) |
| Normalize SVG | — (command and button are SVG-only) | Button under the action row, SVG documents only: applies Core normalization as one undoable edit (TypeScript Core, in-process) |
| Export as Vector PNG | — (command and button are SVG-only) | Button under the action row, SVG documents only: writes the sibling `.png` as a vector-png (TypeScript Core, including the normalization route); the source file is never modified |

## Tests

```sh
npm install
npm run check   # TypeScript type check
npm test        # node --test: detection, routing and new-document suites
```

The suites also exercise packages/ts-core in-process; run
`npm install` in packages/ts-core once so its @resvg/resvg-wasm
dependency is present. No test in the extension suites needs a
Python Core any more (normalization and convert run on ts-core by
default since Issue #59).

Extension-host command tests run in the VS Code test host as part of the
P3 acceptance work; the unit suites above cover the same routing decisions
the commands execute.
