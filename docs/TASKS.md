# Phase/task index

20 issues: Phase 0 (4), Phase 1 (5), Phase 2 (7), Phase 3 (4). Each linked issue and its local planning/issues copy contains complete English and Japanese purpose, target files, implementation, dependency IDs, acceptance and tests. IDs below are stable dependency identifiers; issue numbers are linked explicitly. All issues are initially open. Planning documents do not close technical acceptance gates.

| ID | Issue | Dependencies |
| --- | --- | --- |
| P0-01 | [#1 Audit wire v1 and source preservation](https://github.com/makotosan/vector-png-editor/issues/1) | None |
| P0-02 | [#2 Audit safe-svg-v1 and rendering](https://github.com/makotosan/vector-png-editor/issues/2) | P0-01 |
| P0-03 | [#3 Verify Python dependencies and reuse licenses](https://github.com/makotosan/vector-png-editor/issues/3) | P0-01 |
| P0-04 | [#4 Confirm editor architecture and acceptance plan](https://github.com/makotosan/vector-png-editor/issues/4) | P0-01,P0-02,P0-03 |
| P1-01 | [#5 Package the shared Python Core](https://github.com/makotosan/vector-png-editor/issues/5) | P0-01,P0-02,P0-03,P0-04 |
| P1-02 | [#6 Implement inspect/extract/validate and JSON contract](https://github.com/makotosan/vector-png-editor/issues/6) | P1-01 |
| P1-03 | [#7 Implement build/verify/rebuild transactions](https://github.com/makotosan/vector-png-editor/issues/7) | P1-02 |
| P1-04 | [#8 Define reproducible environments and bridge](https://github.com/makotosan/vector-png-editor/issues/8) | P1-02,P0-03 |
| P1-05 | [#9 Build and validate pip distributions](https://github.com/makotosan/vector-png-editor/issues/9) | P1-03,P1-04 |
| P2-01 | [#10 Register Custom Editor and open routing](https://github.com/makotosan/vector-png-editor/issues/10) | P0-04,P1-02 |
| P2-02 | [#11 Bundle secure Webview and Monaco](https://github.com/makotosan/vector-png-editor/issues/11) | P2-01 |
| P2-03 | [#12 Implement debounced previews and manual toggle](https://github.com/makotosan/vector-png-editor/issues/12) | P2-02,P1-04 |
| P2-04 | [#13 Implement source-preserving save and Save As](https://github.com/makotosan/vector-png-editor/issues/13) | P2-03,P1-03 |
| P2-05 | [#14 Synchronize VS Code undo/redo and recovery](https://github.com/makotosan/vector-png-editor/issues/14) | P2-04 |
| P2-06 | [#15 Protect external change conflicts](https://github.com/makotosan/vector-png-editor/issues/15) | P2-05,P1-03 |
| P2-07 | [#16 Manage Python venv lifecycle](https://github.com/makotosan/vector-png-editor/issues/16) | P1-04,P1-05,P2-01 |
| P3-01 | [#17 Document and test Codex CLI workflow](https://github.com/makotosan/vector-png-editor/issues/17) | P1-05,P2-06 |
| P3-02 | [#18 Run cross-platform automated and real-machine acceptance](https://github.com/makotosan/vector-png-editor/issues/18) | P2-01,P2-02,P2-03,P2-04,P2-05,P2-06,P2-07,P3-01 |
| P3-03 | [#19 Establish CI and protected PR integration](https://github.com/makotosan/vector-png-editor/issues/19) | P0-04,P1-05 |
| P3-04 | [#20 Release VSIX and pip artifacts from tags](https://github.com/makotosan/vector-png-editor/issues/20) | P3-02,P3-03 |

