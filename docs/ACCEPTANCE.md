# Acceptance and release record

[日本語](ACCEPTANCE.ja.md)

## Mandatory stable-release gates

All rows must pass both automated tests and Windows/macOS/Linux real-machine checks before initial stable completion. Record OS/version, Python/native/renderer/VS Code versions, artifact version/hash, date, tester, evidence and failures. A configured matrix or hosted CI run alone does not replace real-machine acceptance.

| Gate | Current Editor status |
| --- | --- |
| Open existing vector-png, edit SVG, save PNG and extract source without loss | Not implemented/tested |
| PNG structure/order/CRC, decoded raster and distinct preview verification outcomes | Experimental Core subset tested; complete container audit and editor acceptance remain open |
| Monaco highlighting/completion/validation/search-replace and synchronized VS Code undo/redo | Not implemented/tested |
| Save As, revert, backup/hot exit, new 1024×1024 transparent document | Not implemented/tested |
| Failed Python/native setup, update/cancel and rollback preserve original and dirty edits | Standalone managed-venv API tested for failure/cancel/rollback and source preservation; extension/native setup UI and dirty-edit acceptance remain open |
| External Codex/CLI updates versus unsaved VS Code edits protect both versions and report conflict | Not implemented/tested |
| Python 3.11–3.13 clean installation across the three OS, then finalize supported matrix | Local Windows Python 3.13 Core/clean-wheel checks; hosted nine-cell matrix added, consult actual runs |
| Packaged offline VSIX with local Monaco/CSP and independent pip wheel/sdist installation | Core development wheel/sdist and clean install tested; six-command distribution and VSIX incomplete |
| GitHub tag runs tests/build/publication of VSIX and pip artifacts; GitHub Releases download/reinstall | Not configured/tested |

Current Core evidence and remaining limits are in [CORE_PROGRESS.md](CORE_PROGRESS.md). All real-machine editor gates remain open.

## Work and branch policy

[20 GitHub Issues](TASKS.md) track the four phases; they remain open until evidence satisfies each issue. Use main protection requiring successful CI, feature branches and PRs. Phase 0 planning adds a planning-check CI job only; it does not substitute for Core/extension/OS suites in P3-03. The branch-protection setting and actual remote CI status must be verified separately from the workflow file. Do not report protection as enabled merely because documentation requires it.

## Evidence recorded on 2026-10-20

Existing Windows Python 3.13.5 implementation subset: 43 passed, 1 deprecation warning. Pinned structural suite: 10 passed. Passive compatibility probes: 21 fixtures and 2 declaration cases; three XML gaps observed. See [PHASE0.md](PHASE0.md) for scope, versions, commands and boundaries. These are baseline research results; no Editor real-machine sign-off exists for Windows, macOS or Linux. Do not release stable until every mandatory row has evidence for all three OS. If an incompatible format change or unresolved product choice becomes necessary, request user judgment before implementing it.

