# vector-png Editor

[日本語](README.ja.md)

VS Code Extension + Python Core + independent pip CLI for editing SVG embedded in PNG. SVG is authoritative; PNG raster is derived. Status: experimental Phase 1 Core with inspect/extract/validate/build/verify/rebuild; the VS Code editor and stable release are not implemented.

- [JSON bridge and environment diagnosis](docs/BRIDGE.md)
- [Writing and conflict boundaries](docs/WRITING.md)
- [Current Core progress and evidence](docs/CORE_PROGRESS.md)
- [Operational JSON CLI contract](docs/CLI.md)
- [Phase 0 findings](docs/PHASE0.md)
- [Architecture and finalized product requirements](docs/ARCHITECTURE.md)
- [Compatibility record](docs/SPEC_COMPATIBILITY.md)
- [Acceptance and release gates](docs/ACCEPTANCE.md)
- [20 phase/task issues and dependencies](docs/TASKS.md)

The English SPEC.md at the revision in [spec-reference.json](spec-reference.json) is the file-format authority. Its SPEC.ja.md is a full informative translation. The Editor v1.0 handoff names the product plan, not a new wire-format version. Reuse is based on [implementation-reference.json](implementation-reference.json). No complete-conformance claim is made.

Work uses feature branches and pull requests into main. CI success must be required by main protection. The initial README bootstrap was the sole setup commit on main; Phase 0 and the initial Core were integrated through PRs, with follow-up work on codex/ feature branches. Stable completion requires both automated and Windows/macOS/Linux real-machine tests. See the acceptance record for unexecuted work.

