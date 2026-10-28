# Vector PNG Editor extension

VS Code extension package for vector-png files: PNG images that carry their
SVG source in a single compressed `iTXt` chunk with the keyword
`vector-png.svg` (wire v1).

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
with history synchronization handled in P2-05.

## P2-03: debounced previews and manual toggle

Edited previews render only through the Python Core: after 300 ms idle
the host validates the edited source via the bridge `LatestValidation`
lane and, only on success, renders it with the Core `build` command
into a private preview file. Stale results are discarded by generation,
so the latest source wins. The preview pane opens on the actual saved
raster and switches to the edited preview only when the user clicks the
toggle - never automatically. Set `vectorPng.corePythonPath` to a Python
3.11-3.13 with the Core installed; without it, edited previews report
unavailable and the saved preview keeps working.

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

The view type and commands have not changed since P2-01.
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
