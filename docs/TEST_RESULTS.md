# Test results — real-machine acceptance

[日本語](TEST_RESULTS.ja.md)

## macOS run — 2026-10-29 (Issue #18, checklist v2)

- **Machine:** MacBook Air M4, macOS 26.5.2 (25F84), VS Code 1.144.0
  (arm64). System Python 3.9.6; the run used Homebrew Python 3.13.16.
- **Artifacts:** editor VSIX "build 13" (PR #56 head, Core wheel
  bundled; SHA-256
  `1a1d37345dea28ece61fdf44bab93bf638f43d9d4ca7c021595b533e5c335f90`,
  matched) and the prerelease v0.1.0.dev3 Core wheel (SHA256SUMS
  check OK).
- **Executor:** Codex on the user's machine; the user submitted the
  filled checklist v2 on 2026-10-29.
- **Verdict:** macOS acceptance is **not yet complete**. Everything
  passed except three items that differ from the expected outcome
  (5.7 FILL undo, 6.2 Normalize undo, 7.1 Environment Status). All
  three were root-caused and fixed on the PR #56 branch after this
  run (build 14); a re-check of those items is pending.

### Section results

- **§1 Artifacts:** pass. Wheel checksum OK; build-13 VSIX hash
  matched.
- **§2 CLI/Core:** all pass. `validate` reported
  `profile_check: passed`, `verify` reported `preview: match`,
  `inspect` reported `kind: vector-png`. The extracted source was
  byte-identical (SHA-256
  `344596ae86b6550bb1073f5a93fdee2bc48b9af890be20e9437643308e164a44`
  for both files). The broken file was rejected with exit code 3,
  `invalid-container`, "Invalid PNG ending".
- **§3 Install and no-Core checks:** pass. The VSIX installed and
  the editor starts via Open With (by design the default viewers —
  Office Viewer / Image Preview — keep opening these files; the
  editor stays opt-in). The clone folder opened with a clean git
  status. An SVG opened before any environment setup showed the
  split UI, a rendered Editing preview, and a disabled PNG button.
  Code folding worked (chevrons collapse ranges). A plain PNG
  opened view-only with no buttons and its SHA-256 unchanged
  (`60d0e55283e573e7051d0e6aa454cdb432aa58eca87ce702cae1975a7661c474`
  before and after).
- **§4 Environment setup:** pass. "Set Up Python Environment"
  completed with the bundled wheel ("environment ready"), and
  Environment Status showed the managed environment and effective
  Python. No native-Cairo remedy was needed on this machine.
- **§5 vector-png:** 5.1 pass (Editing renders after the
  generating message; PNG toggle shows the stored raster). 5.2
  pass (closing and reopening renders again; "Output already
  exists" did not recur). 5.3 pass (completion; `stop` offered
  only inside `<linearGradient>`). 5.4 pass (edit + save; preview
  follows; CLI `verify` still `preview: match`). 5.5 pass
  (undo/redo across a save). 5.6 pass (Format indents by nesting;
  Copy SVG pastes the current source; Wrap toggles). 5.7
  **background part pass** (preset switching changed neither the
  source nor the file — SHA-256
  `c8084ad4b147891cb2bdc3c01e110097d42590055e74a91ee93938945b83ecc9`
  unchanged, no dirty marker) but the **FILL undo part differs**
  (finding F1). 5.8 pass (Export SVG byte-identical to the source
  extracted from the saved PNG). 5.9 pass (Export Plain PNG:
  `inspect` reports `kind: png`, `extract` fails with
  `ordinary-png`, exit 7). 5.10 pass (New Document: 1024×1024,
  every pixel alpha 0, `verify` reports `preview: match`). 5.11
  pass (conflict notice shown; the unsaved version was exported
  intact with its `fill="#ff0000"`, and the external version kept
  SHA-256
  `2739d60098bcc08936992c066b56ea15ecff211e2e92c915d3ac80b289cc19cd`
  and verified `preview: match`).
- **§6 SVG (Issue #47):** 6.1 pass (an SVG with `<style>` and
  `class` opens and renders in Editing). 6.2 **differs**: the
  normalization itself behaved (summary notification shown, the
  saved source validates `profile_check: passed`), but the
  single Cmd+Z revert did not take effect (finding F1). 6.3 pass
  (the Export as Vector PNG button created the sibling PNG;
  `verify` reports `preview: match`; it opens in the editor).
- **§7 Failure case:** 7.1 **differs** (finding F2). VS Code and
  the files were unharmed.

### Findings and dispositions

- **F1 — Host-originated edits could not be undone with Cmd+Z**
  (items 5.7 and 6.2). The webview applied host source updates
  (Normalize SVG, FILL Apply, host undo/redo, external-change
  reloads) with Monaco's `editor.setValue()`, which discards the
  undo stack; edits typed in Monaco undo normally (5.5 passed).
  The mechanism was verified against the bundled Monaco 0.57:
  a `setValue` change is not undoable, while
  `editor.executeEdits()` plus `pushUndoStop()` is, including via
  the focused keyboard undo. **Fix (PR #56):** `sourceSync` now
  applies through `editor.executeEdits('vectorPng.hostSync', …)`
  with `pushUndoStop()`; the initial load keeps `setValue` on
  purpose, so a freshly loaded source cannot be undone back to an
  empty model. Re-check with build 14 pending.
- **F2 — Environment Status presented a nonexistent Python as
  usable** (item 7.1). With `vectorPng.corePythonPath` set to
  `/nonexistent/python3`, the status dialog showed it as the
  Configured and Effective Python with no indication it was
  invalid. **Fix (PR #56):** the status now annotates a missing
  configured or effective path with "(file not found)".
  Re-check with build 14 pending.

### Remaining acceptance scope

The ACCEPTANCE.md stable-release gate also needs Windows and
Linux real-machine runs. Windows is largely covered informally by
the user's day-to-day use on 2026-10-29 (Editing preview including
the reopen fix, the panel buttons and labels, Export PNG through
the managed environment); Linux is still outstanding.
