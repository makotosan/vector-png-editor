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

## Source-preserving save and Save As — P2-04

The provider is now a full `CustomEditorProvider`. Saving never writes
bytes directly: `src/save.ts` orchestrates the flow and
`src/coreSave.ts` runs it through the bridge to the Core `build`
command with the destination's current SHA-256 as the revision token.
The Core validates the profile, renders at the IHDR viewport, verifies
the candidate and publishes atomically, retaining a backup snapshot of
the overwritten original. A profile violation blocks the save, a
destination changed since the token was read is a conflict, and any
failure leaves the original file untouched while the provider throws,
so VS Code keeps the dirty buffer. Source bytes are preserved exactly -
BOM, CRLF and formatting survive because the source is never
reserialized. Save As creates a new file, or overwrites an existing
destination only under that file's own token. Cancellation is honored
before the Core starts; after launch the Core's staged publication is
atomic, so a save never leaves a partial file.

Revert reloads the source from disk. Backups copy the current file
plus a small sidecar holding the pending source, so hot-exit restore
reopens with the unsaved edits intact. Edit events are emitted per
change with basic undo/redo closures; authoritative undo/redo history
synchronization is P2-05, and external-change watching is P2-06 (the
save-time token check already prevents silent overwrite).

Local verification: 56 extension unit tests passed with a real Core
(50 passed and 6 Core-integration tests skipped without one). The
integration tests exercise actual filesystem saves: a BOM/CRLF source
round-trips byte-exactly with its backup snapshot retained, an invalid
source is blocked with the original file's hash unchanged, a stale
token produces a conflict and preserves the external version, and Save
As writes a new file without touching the original. The TypeScript
type check passed. Extension-host and packaged-VSIX tests remain P3
acceptance work, so P2-04 stays open until that evidence exists.

## Undo/redo synchronization and recovery — P2-05

`src/history.ts` is now the single authoritative history for each
document. A webview edit is recorded exactly once there; typing bursts
coalesce within one second into one undoable entry, while discrete
edits (such as replace-all) stay separate. Identical re-deliveries -
the echo of a host sync returning from the webview - record nothing
and fire no edit event, which is what prevents feedback loops between
Monaco, the host and VS Code's undo stack. The `CustomDocumentEditEvent`
undo/redo closures only move the history pointer and sync the resulting
snapshot to the webviews. Saving never clears the history, so undo
across a save restores the pre-edit source, and redo returns to the
saved state; dirtiness is always whether the current snapshot differs
from the saved source. Revert resets the history to the disk state.

Multiple editor panels per document are enabled: a source change in
one panel is recorded once and synced to the others through the same
guarded path (full-snapshot sync; the secondary panel's cursor is not
preserved). Backup persistence moved to `src/backup.ts`: the backup
copies the file bytes and a JSON sidecar with the pending and saved
sources, and restore reopens with unsaved edits byte-exact and a fresh
history rooted at the restored state.

Local verification: 66 extension unit tests passed with a real Core
(60 passed and 6 Core-integration tests skipped without one). The new
history tests cover undo/redo walks, echo suppression, redo-tail
truncation, coalescing, save-undo-redo dirtiness, replace-all steps,
reset and bounds; the backup tests cover byte-exact round-trips and
corrupt-sidecar handling. The TypeScript type check passed.
Keyboard-level undo/redo and multi-panel behavior in a live editor
remain extension-host acceptance work (P3), so P2-05 stays open until
that evidence exists.

## External change conflicts — P2-06

Each document now carries an `ExternalChangeTracker` (`src/watch.ts`)
holding the SHA-256 of the file bytes the editor last agreed with -
at open, after each save, and after each reload. A file-system watcher
on the document's own file classifies every observed disk state by
content, never by timing, so the echo of the editor's own save is
ignored by construction. An external change to a clean document is
reloaded (after the usual passive detection, never unchecked). An
external change to a dirty document, an unreadable change, or a
deletion under a dirty document preserves the buffer untouched,
notifies the user in the editor and by a warning message, and marks
the document conflicted.

While a document is conflicted, a plain save cannot proceed: it asks
explicitly - reload from disk, overwrite the external change, or Save
As - so both versions survive until the user decides and no CLI edit
can silently overwrite dirty source (or vice versa). Resolving by
reload adopts the disk state; overwriting proceeds through the normal
token-checked save (P2-04), whose revision token remains the second
line of defense against a change landing between observation and
save. Deleting the file under a dirty document lets the next save
recreate it from the preserved buffer; renaming is observed as a
deletion of the old path plus activity on the new one.

Local verification: 74 extension unit tests passed with a real Core
(66 passed and 8 Core-integration tests skipped without one). The new
tests cover the full decision matrix (own-save echo, clean reload,
dirty conflict, unreadable content, deletion/recreation, conflict
self-healing when the agreed bytes return) plus integration scenarios
where the Core CLI itself is the external editor: a dirty buffer
survives its edit and an explicit overwrite then saves, and a clean
document reloads after its edit and observes a deletion. The
TypeScript type check passed. Live watcher behavior in an extension
host remains P3 acceptance work, so P2-06 stays open until that
evidence exists.

## Python venv lifecycle — P2-07

The extension now integrates the bridge managed-environment manager
(P1-04) instead of requiring a hand-set interpreter path. A new
framework-free discovery module probes the usual candidates
(`py -3.13/-3.12/-3.11/-3` on Windows; versioned `python3.x` names then
`python3`/`python` elsewhere) with an isolated version probe that
reports the real executable - discovery is read-only, and a miss is
explained to the user (no Python, or only unsupported versions) with
per-platform install guidance, including the native Cairo note. The
**Set Up Python Environment** command locates trusted Core artifacts
(the `vectorPng.coreWheelPath` setting, a wheel bundled under
`managed/`, or a sibling checkout's built wheel), asks before any
network use (default offline with a local wheelhouse), and runs the
manager with progress and cancellation: the new environment activates
only after the manager's package, dependency and real-render health
checks, so a failed or cancelled setup preserves the previously
active environment and every document. Status and rollback commands
expose the manager's state and health-checked rollback. Python
resolution for previews and saving is now the explicit setting when
set, otherwise the managed active interpreter; a corrupt store fails
closed. The extension bundles a byte-identical copy of the repository
requirements lock under `managed/`, guarded by a test.

Local verification: 84 extension unit tests passed with a real Core
(76 passed and 8 skipped without one), including discovery matrices,
resolution precedence, corrupt-store handling and lock parity. Beyond
unit tests, the full flow was executed for real in a path containing
spaces and Japanese characters: discovery found Python 3.12.3, an
offline setup from the built 0.1.0.dev3 wheel and a local wheelhouse
activated an environment whose managed Core validated a source, a
bad-digest retry was rejected with the active environment preserved,
a second setup switched activation, and rollback returned to the
first environment. The TypeScript type check passed. Running the
commands inside a live VS Code host remains P3 acceptance work, so
P2-07 stays open until that evidence exists. This completes the P2
series (P2-01 to P2-07).

## Generated profile metadata in Monaco — v1.2 Phase 2

The editor now consumes the generated safe-svg-v1 metadata instead of
relying only on the mirrored constants. The extension host loads
`schemas/safe-svg-v1.monaco.json` (generated from the policy; packaged
under `media/schemas` by `scripts/copy-schemas.mjs`, or read from the
repository checkout during development), parses it strictly, and
sends elements, attributes, content models and text elements to the
webview in the init message. Monaco completion inside an element is
limited to that element's allowed children - for example, `stop` is
offered only inside gradients - while attribute completion and the
advisory diagnostics are unchanged. Missing or invalid metadata falls
back to the mirrored constants in `profile.ts`, and the Python Core
validator remains authoritative in all cases. The Codex Skill that
drives generation from the same profile lives at
`skills/vector-png/SKILL.md`; SC-10 exercises its workflow end to end.

Local verification: the extension suite passes with the new
profile-data tests (canonical metadata parity with the mirrored
profile, content-model child sets, rejection of foreign profiles),
and the TypeScript check passes. Live VS Code host confirmation
remains part of the P3 acceptance work (Issue #18).
