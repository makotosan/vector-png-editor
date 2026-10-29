# Architecture and finalized product requirements

[日本語](ARCHITECTURE.ja.md)

## 1. Product scope

The product is vector-png Editor: a TypeScript VS Code extension whose Core (packages/ts-core) runs in-process in the extension host. Initial extension distribution is VSIX through GitHub Releases. Target platforms are Windows/macOS/Linux. Stored SVG uses safe-svg-v1. There is no standalone CLI: the Python Core and pip CLI of the first phases were retired in Phase 3 (Issue #60) once every feature had been ported to the TypeScript Core. Codex edits the SVG source in the editor; ChatGPT UI is outside the initial release. SVG is authoritative and raster PNG is derived. The product handoff v1.0 does not change the pinned wire v1 draft 0.1.

The command is Vector PNG: Open in Editor. Detect embedded vector-png content instead of requiring a filename suffix. Ordinary PNG opens in the VS Code standard image viewer. Malformed vector-png produces a diagnostic rather than silently becoming an ordinary PNG. New documents start at 1024×1024 pixels with transparent background.

## 2. UI and document model

The left pane previews either the saved PNG raster or the edited SVG; the right pane is local Monaco SVG source. Supply XML highlighting, safe-profile-aware completion, search/replace and diagnostics. After 300ms without input, validate and update the edited preview. Switching saved/edited previews is manual only; no automatic image difference detection. Cancel superseded work and discard stale results using request/document revision IDs. Never format, normalize or silently strip SVG during save.

Use CustomEditorProvider with a CustomDocument holding the exact source bytes, decoded text plus BOM/newline metadata, IHDR viewport, saved raster, saved disk revision and current source revision. Monaco models can normalize line endings, so exact byte preservation must be tested explicitly; retain the original byte buffer when unchanged and preserve BOM/newline policy across deliberate edits. Send immutable edit events with undo/redo callbacks through CustomDocumentEditEvent. VS Code history is authoritative; Monaco edit/undo/redo handling must prevent duplicate history and message loops. Save, Save As, revert, backup, hot-exit and multi-panel state are required. This is a design pending extension-host proof, not a claim that APIs alone provide synchronization.

Watch external changes. A clean document can reload; a dirty document retains its buffer and saved/external versions and reports conflict. The Core must prevent stale saves from losing external updates, including the race between a revision check and replacement. A simple pre-save hash is not sufficient proof; P2-06 must test and document the implemented concurrency boundary. No automatic overwrite or merge of dirty edits.

## 3. Shared Core and save

The TypeScript Core (packages/ts-core) is the single Core: a library the extension host calls in-process for bounded container parsing, exact extraction, profile validation, rendering and validated atomic publication. It descends from the existing MIT Python code at the pinned implementation SHA, ported behaviour-for-behaviour with attribution; the Python original is retired (see implementation-reference.json). The extension and any future caller use the same Core generation path - there is no separate CLI.

The Core implements inspect, extract, validate, build and rebuild as library functions with stable error codes (TsCoreError) and structured diagnostics; a standalone verify entry point remains to be ported. Error semantics distinguish ordinary PNG, invalid-container, invalid-svg, unsupported-profile, resource-limit, render-mismatch and render-not-checked; the final API strings/codes are defined by the Core and tested with it. Preserve extracted source bytes independently of local renderer pixel equality. Inspection must not execute SVG or insert unchecked SVG in the DOM.

Save validates SVG, generates the PNG at IHDR dimensions, embeds unchanged source bytes, validates the complete container/profile/output preview, checks the conflict policy and publishes atomically. A profile violation blocks save. Timeout, cancellation, write failure or conflict must preserve the original file and unsaved edits. Backup/Save As must protect original data. Exact local raster verification records renderer/version, viewport, fonts, color/alpha handling and comparison method; no cross-engine equivalence or authenticity claim.

## 4. Runtime and Webview security

No Python installation and no native libraries are required. The VSIX bundles the TypeScript Core and the resvg renderer as WebAssembly; text rendering uses the host's system fonts, loaded once per activation as buffers (the interim font strategy of Issue #61). Nothing is installed or modified outside the extension's own storage.

Bundle Monaco, scripts, styles and workers locally. Set restrictive Content Security Policy, localResourceRoots and validated message schemas. No CDN or external SVG resources/scripts. Treat source as data; do not interpolate unchecked SVG into an active DOM. Prefer Core-generated raster for the edited SVG preview, labeled by source state, so generation remains shared. CSP/worker setup and completion support require packaged/offline extension-host tests.

## 5. Repository and delivery

Source paths (the TypeScript Core is now implemented; see [current progress](EXTENSION_PROGRESS.md) for delivered scope):

```text
vector-png-editor/
  packages/ts-core/       # TypeScript Core: container, validation, normalization, rendering
  packages/extension/     # Custom Editor, local Monaco, bundled host code
  schemas/                # safe-svg-v1 policy and generated profile artifacts
  docs/                   # requirements, research, acceptance, paired translations
  evidence/               # reproducible finite check results
  tools/                  # research and validation tools
  spec-reference.json
  implementation-reference.json
  .github/workflows/
```

Manage work in GitHub Issues by Phase/task. Every issue contains purpose, planned target files, implementation, dependency IDs, acceptance and tests. Keep main protected with successful required CI, use feature branches and PR integration. GitHub Actions must test the TypeScript Core and the extension on the supported OSes, build the VSIX, and test tag-triggered publication to GitHub Releases. Release and real-machine gates are in [ACCEPTANCE.md](ACCEPTANCE.md). Do not mark stable completion until all gates pass.

## 6. API references and remaining verification

Official [Custom Editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors) and [VS Code API](https://code.visualstudio.com/api/references/vscode-api) describe custom document edit events, save, revert and backup. The [Webview guide](https://code.visualstudio.com/api/extension-guides/webview) describes CSP and local resource handling. These support the architecture choice; they do not prove Monaco history or conflict handling. P0-04/P2-05/P2-06 must verify those integrations in the extension host. Existing upstream extract/inspect couple profile/rendering with discovery and lack the needed separate API outcomes; this requires Core refactoring rather than a blind command rename. No incompatible format change is authorized; request user judgment before such a change or an unresolved product decision.

