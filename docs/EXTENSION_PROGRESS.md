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

## Plain PNG view mode — Issue #46

Opening an ordinary PNG (a valid PNG with no embedded SVG source)
through the custom editor - for example via "Open With…" - previously
failed: `openCustomDocument` rejected it with "no embedded SVG
source", so the user got an error instead of the picture. The custom
editor now opens such files in a view mode.

A new pure module, `src/openMode.ts`, decides how the custom editor
opens a detected file: `vector-png` opens the full editor as before,
`ordinary-png` opens view mode, and `corrupt-vector-png` / `not-png`
are rejected with exactly the diagnostics they produced before. Only
the ordinary-PNG case changed.

A view-mode document carries no source: nothing is extracted and no
SVG source is fabricated. Its `pendingSource` stays undefined, so the
save path has nothing to write and the document can never become
dirty; opening and closing leaves the file on disk byte-identical.
No file watcher, edit history, external-change tracker or Python Core
is set up for it, and revert is a no-op. The panel is a static page
(`buildViewHtml` in `src/webviewHtml.ts`) under the same restrictive
CSP, with scripts disabled entirely: the meta line reads
"`<width> x <height> PNG — no embedded SVG source (view only)`", and
the raster image itself is shown centred on a checkerboard
(`#view-pane` in `webview/editor.css`). There is no Monaco pane, no
error notification and no diagnostic.

Unchanged boundaries: the "Vector PNG: Open in Editor" command still
routes ordinary PNGs to the default image viewer, the custom editor
keeps priority `option` (ordinary PNGs are never hijacked), and
corrupt vector-png / non-PNG files still produce their diagnostics.
The issue's open question - a "Create SVG source…" action converting
a plain PNG to vector-png - was explicitly not implemented; it
remains undecided in Issue #46.

Local verification: the extension suite passes (88 passed, 8 skipped
- the pre-existing Core-integration skips - 0 failed), including a
new `open-mode` suite covering all four detection kinds through the
custom-editor open decision plus an on-disk byte-identity check, and
new webview tests pinning the view-only page (notice, image, no
scripts, no Monaco, no fabricated SVG) and its checkerboard CSS. The
TypeScript check passes. The manual VS Code check from the issue's
test method (ordinary PNG, vector-png, corrupt vector-png and a
renamed non-PNG, with before/after hashes) remains part of the P3
real-machine acceptance work (Issue #18).

## SVG open and vector-png export — Issue #47

The custom editor now also opens plain `.svg` files (the selector
gains `*.svg` under the same view type and `option` priority, so the
default SVG experience is unchanged). An SVG document shares the PNG
editing model - pending/saved source, undo/redo history, multi-panel
synchronization, backup sidecar recovery and external-change
tracking - with kind-specific acquisition and persistence: the source
is the file's own UTF-8 text, the document size comes from the root's
width/height attributes (else the viewBox, else the Core's default
1024x1024 viewport) parsed by `src/svgSource.ts` with no new
dependency, and saving writes the text back byte-exact as a plain
UTF-8 write guarded by the same SHA-256 revision agreement the Core
enforces for PNG saves (`src/svgSave.ts`) instead of a Core rebuild.
Display is never blocked by safe-svg-v1 validation: diagnostics stay
advisory in the source pane, and the edited preview renders the
source as-is from a private file through the webview `<img>`
(`src/svgPreview.ts`), because the Core preview path validates
against the profile before rendering and cannot show a general SVG.
No SVG markup enters the DOM and the restrictive CSP is unchanged.

The new command `Vector PNG: Export as Vector PNG`
(`vectorPng.exportAsVectorPng`; command palette, explorer context for
`.svg`, editor context in this editor) exports the current source -
the open document's possibly unsaved source, or the disk content for
an unopened file - to the sibling `.png`, orchestrated by
`src/export.ts` over the production dependencies in
`src/coreExport.ts`. The source is validated through the Core
`validate --profile safe-svg-v1`: a valid source exports through the
Core `build` command with the save path's revision-token discipline
(an existing target is replaced only after a modal Overwrite
confirmation, under its current SHA-256; a plain PNG target is
covered by the same confirmation). An invalid source writes nothing:
the structured profile diagnostics (severity, code, element,
attribute, line, column, message, suggestion) go to an error
notification with a Show diagnostics action that opens them as a
text document, and only an explicit Export via normalization choice
runs the Core `convert` command (normalization with its rendering
gate, then build). Because `convert` is strictly no-clobber, an
existing target is moved aside first and restored verbatim if the
conversion fails or throws, so a failed or declined export never
leaves a partial or replaced PNG; the conversion report's
accessibility-loss warnings are surfaced after a successful
normalization export. The source `.svg` is never modified by an
export. `validate --profile` and `convert` cannot be expressed over
the protocol-1 transport, so they run through the Core's versioned
JSON CLI under a bounded, shell-free spawn that mirrors the bridge's
discipline, while `build` reuses the protocol runner exactly like
saving; no Python Core changes were needed.

Verification: the extension suite passes 105 tests with 0 failures
and 10 skips by default (baseline on main: 79 passed, 8 skipped; the
skip delta is two new Core-integration tests gated on
VECTOR_PNG_TEST_PYTHON like the existing ones), and 115 of 115 with
a real Core, including end-to-end exports through both the `build`
route (embedded source round-trips byte-exact) and the `convert`
route (normalized output, diagnostics presented first, source file
untouched). New unit coverage: manifest registration, `.svg`
routing, size parsing, as-is preview files, the text save round-trip
and its conflict guard, and the export orchestration against fake
dependencies (overwrite declined on both routes, failed-conversion
restore, conflict surfacing). The TypeScript check passes. Live
VS Code host confirmation (opening the nine corpus SVGs, unsaved-edit
export, conflict dialogs) remains part of the P3 acceptance work
(Issue #18); Issue #47 therefore stays open until that evidence
exists.

## Normalize SVG command — Issue #47 follow-up

At the user's request, the same issue adds an explicit command,
`Vector PNG: Normalize SVG` (`vectorPng.normalizeSvg`), that replaces
an open `.svg` document's source with its normalized form. It is
deliberately separate from open, save and export: normalization is
an explicit operation in this project, never an automatic step. The
command is enabled only for `.svg` documents in this editor (a
`vectorPng.documentIsSvg` context key tracked from the active panel
gates the palette and editor-context entries; the explorer entry
targets `.svg` files), never for vector-png documents. Invoked on an
unopened `.svg` file, it opens the file in the editor first and
operates on the document; it never writes a file behind the editor's
back.

The Core `normalize` operation runs on the document's current source
- unsaved edits included - writing its input, output and report to
temp locations only (`src/normalize.ts`, `src/coreNormalize.ts`).
Because the Core operation includes the svg-normalization-v1
before/after rendering gate, a success is guaranteed to render
pixel-identically to the source it replaced. The normalized text is
applied as an ordinary edit through the history machinery: it lands
as a single dirty, undoable change (one undo restores the
pre-normalization source), and saving it uses the ordinary save flow
with its conflict protection. A short summary drawn from the
conversion report follows - declarations materialized, markers
expanded, style elements and class attributes resolved,
accessibility migrations - and any recorded accessibility losses are
surfaced explicitly in a separate warning, so normalization never
looks silent-lossless. When the output is byte-identical to the
current source, the command reports the document as already
normalized and makes no edit (no dirty state, no history entry).
On any section 7 failure the document is left completely untouched
and the failure is shown with its code and message, with the
report's structured errors available in a diagnostics document -
the same presentation discipline as the export validation failure.

Verification: the suite passes 111 tests with 0 failures and 12
skips by default (the two new real-Core tests gate on
VECTOR_PNG_TEST_PYTHON like the existing integration tests), and
123 of 123 with a real Core. The orchestration tests drive a
document double backed by the real SourceHistory, proving the
single undoable edit, the untouched-on-failure guarantee and the
already-normalized no-op; the integration tests normalize a styled
source end to end (its output is a fixed point) and surface an
unsupported-css failure with its structured errors. Live host
confirmation joins the Issue #18 acceptance list.

## Office Viewer-style split UI — Issue #45

The editor page for editable documents (both vector-png and `.svg`
kinds; the Issue #46 view-only page is unchanged) is now a split
layout in the style of a document viewer. On the left, a code pane: a
compact toolbar with **Save** and **Format** buttons and the document
meta line, over the Monaco editor with its existing diagnostics,
completion and edit sync. On the right, a **Preview** panel: a header
with background preset toggles (checkerboard / white / black), the
**FILL** and **BACKGROUND** rows, the Saved/Edited preview toggle
with its status text, the preview stage with the rendered image
centred on the chosen background, and a bottom action row of **Copy**
| **Export** | **Export PNG**. The toggle labels read "Saved" /
"Edited" for both document kinds (the state machine semantics are
unchanged: the pane opens on the saved view and switches only
manually). The styling follows the user's chosen design B (VS Code
dark-theme fusion): every colour is a VS Code theme CSS variable
(`--vscode-editor-background`, `--vscode-sideBar-background`,
`--vscode-panel-border`, `--vscode-button-background`,
`--vscode-input-background`, `--vscode-focusBorder`, and their
companions) collected in a single `:root` block in
`webview/editor.css`, with the default dark values (#1e1e1e editor
family, #252526 panel, #3c3c3c borders, #0e639c accent) only as
`var()` fallbacks, so the page follows the active colour theme.
Save and Export PNG are the primary accent buttons; everything else
is a secondary button; the checkerboard is a translucent-grey
`repeating-conic-gradient` that reads as dark greys on a dark panel
and light greys on a light one. The Monaco code area follows the
same theme: the theme class VS Code stamps on the webview body
(`vscode-dark` / `vscode-high-contrast`) selects Monaco's matching
built-in theme, kept in step by a class observer, so the whole page
reads as one surface. No new dependencies, no inline event
handlers, no SVG markup in the DOM (the preview remains an `<img>`),
and the CSP is unchanged (`default-src 'none'`, nonce scripts).

The **FILL** row shows the root `<svg>` element's current `fill`
attribute value (a colour, `url(#plate)`, or empty) in an editable
text field beside a native colour input. Nothing applies while
typing or picking: only Enter in the field or the Apply button posts
the value, and the host then makes exactly one ordinary edit —
recorded in the history, undoable, dirty-marking, saved only through
the normal save — that sets or removes the root element's `fill`
presentation attribute; clearing the field and applying removes the
attribute. The read/write is a small pure module
(`src/rootFill.ts`): it scans the prolog and the root start-tag only,
preserves the rest of the document byte-for-byte (an existing `fill`
keeps its quote style, so re-applying the shown value is a no-op),
handles `>` and `/>` root tags, and reports the root as unavailable
when it cannot be scanned with confidence — the row is then disabled
with a title explaining why, and nothing is rewritten. The host
posts the root fill on init, on every cross-panel sync and on every
recorded edit; in the webview, a refresh that arrives while the
field is focused or dirty is deferred and lands on blur, so an edit
in progress is never overwritten mid-keystroke and focus is never
stolen. The **BACKGROUND** row is preview presentation only: it sets
the preview stage's background colour and never reaches the source
or the file. A preset and a custom colour are mutually exclusive —
choosing a custom colour (swatch or hex field) deselects the
presets, choosing a preset clears the custom colour, and clearing
the hex field returns to the checkerboard preset. Invalid colour
text is rejected in the field (the last valid value is restored and
the field is marked invalid) without touching anything else; `#rgb`
and `#rrggbb` are accepted and normalized (`webview/preview-state.js`).

**Save** routes through `workbench.action.files.save`, so the
custom document save lifecycle (conflict handling, Core write) runs
exactly as for Ctrl+S. **Format** applies a conservative
indentation-only formatter (`src/formatSource.ts`) as one ordinary
edit: it rewrites only the leading indentation of structural lines
to match the element nesting, never joins or splits lines, and
leaves `<style>`/`<text>`/`<tspan>` content, comments and CDATA
byte-for-byte untouched; an already formatted source is a no-op
reported on the meta line. **Copy** writes the current source text
to the clipboard on the host and confirms on the meta line.
**Export** shows a save dialog (default `<base>.svg` for a
vector-png document, `<base>-copy.svg` for an `.svg` document) and
writes the current source text as UTF-8; the open document and its
file are never modified, and choosing the document's own path is
refused. **Export PNG** saves the rendered raster as a plain PNG
with no embedded source (`src/exportPng.ts`, Core dependencies in
`src/coreExport.ts`): the raster always comes from the Python Core —
through `build` for a source that validates under safe-svg-v1, or
through the normalization `convert` route for one that does not, in
which case the result tells the user the PNG was rendered via
normalization; if the chosen route fails, the other is tried once,
and only when both fail is the primary route's error reported. The
built vector-png's single source iTXt chunk is stripped in
TypeScript (`stripSourceChunk`), copying every other chunk as raw
bytes, so the written file is the identical raster without the
source. The dialog default is `<base>.png` for an `.svg` document
and `<base>.plain.png` for a vector-png document; rendering happens
before the dialog, any failure writes nothing, and the document's
own path is refused as a target.

Panel state — the preview mode and the background preset/custom
colour — persists per panel in the existing webview state mechanism
(`vscode.setState`); the FILL value is not panel state and always
mirrors the source. All new webview-to-host messages pass the strict
validation in `src/messages.ts` in the existing style: `saveDocument`,
`formatSource`, `copySource`, `exportSource` and `exportPng` are
exact no-field messages, and `applyRootFill` carries a single value
string capped at 256 characters with control characters rejected.

Verification: the extension suite passes 164 tests with 0 failures
and 12 skips by default, and 176 of 176 with a real Core (the
baseline on main was 120 passing / 12 skipped by default, 132 of 132
with a real Core), and the TypeScript check passes. New coverage:
the root-fill module (colour, `url(#id)` and quoted reads; set,
replace in both quote styles, remove on empty; self-closing roots;
byte-for-byte preservation of everything else; malformed roots
unavailable), the formatter (nesting, raw-region preservation,
idempotence, already-formatted no-op), the message validation for
every new type in exact and hostile shapes, the panel background
state machine and hex normalization, the editor HTML structure and
design-B CSS variables, the Monaco theme sync, and the plain-PNG export with fake
dependencies (build route strips exactly the source chunk,
convert route reports the normalization, both-routes-fail and
strip-failure write nothing, dialog cancel writes nothing). Live
screenshot comparison in a VS Code host remains Issue #18 work;
Issue #45 stays open for that check.
