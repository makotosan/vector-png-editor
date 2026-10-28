# Phase 0 research — 2026-10-20 (Asia/Tokyo)

[日本語](PHASE0.ja.md)

Historical research snapshot before Core implementation. Current results and resolved XML gaps are in [CORE_PROGRESS.md](CORE_PROGRESS.md); upstream code and this baseline evidence remain unchanged.

## 1. Evidence and scope

Reviewed the pinned English SPEC.md, safe-svg-v1 and IMPLEMENTATIONS.md at [8238ebdaa136f448affa53133b99ee5afde5765a](https://github.com/makotosan/vector-png-spec/tree/8238ebdaa136f448affa53133b99ee5afde5765a), plus the existing Python project at [d00dd8800cdf6978ebf1d5c6ae61042c7fbadbc2](https://github.com/makotosan/vector-png/tree/d00dd8800cdf6978ebf1d5c6ae61042c7fbadbc2): vector_png.py, pyproject.toml, requirements, tests, examples, CI, license, OSS review and compatibility record. GitHub confirms source blob 4828b4bb60a97704161bf71e70eaeff8fc97ef49. Local tested source SHA-256 is recorded in implementation-reference.json. Local repository folders are source snapshots inside an uncommitted parent Git repository, not independent upstream clones. No history was inferred from those folders.

The specification repository supplies format/profile documents and finite test tools. The reusable production Python implementation is in makotosan/vector-png, not in the specification's test transformer. No upstream format or implementation files were changed in this work. Phase 0 research is recorded; P0 issues remain open until their full audits, support matrix and editor spike acceptance criteria are met.

## 2. Container and profile findings

SPEC §§2–3 stores exactly one compressed iTXt keyword vector-png.svg with flag 1, method 0, zlib UTF-8 SVG. No JSON wrapper, version field or profile marker is added. PNG CRC/order/decoding, duplicate keywords across iTXt/tEXt/zTXt, APNG rejection and trailing bytes matter. Extraction must preserve decompressed bytes, including optional BOM; XML must declare UTF-8 if an encoding is declared.

SPEC §4 baseline limits are 1,000,000 SVG bytes, 32,000,000 PNG bytes, 4096 pixels/side and 4,000,000 pixels. Existing code uses those numeric limits and at most 10,000 PNG chunks. safe-svg-v1 allows only its enumerated SVG elements/attributes, local gradient/clip references, 5000 elements, depth 32 and 100,000 code points per attribute. It rejects CSS/style, scripts, images/data URLs, hyperlinks, use, foreignObject, animation, DTD/entities, external references and non-declaration processing instructions. Comments and escaped characters are allowed. Existing renderer rejects external fetching and runs in a 20-second subprocess; this is not an OS sandbox or hard memory quota.

SPEC §§6–7 requires the stored source and preview to be regenerated together at the PNG IHDR viewport and published without partial updates. Container validity, safe-profile support and renderer-specific preview verification are independent claims. Exact CairoSVG RGBA comparison is existing local policy, not a universal format requirement or author authentication. Font selection remains host-dependent. The optional normalization feature in upstream 0.2.0 is an explicit import facility; it is not needed for this initial safe-svg-v1 editor and must never run automatically on extraction/save.

## 3. Reuse and CLI gaps

| Required command | Existing capability | Required work |
| --- | --- | --- |
| inspect | JSON inspect; invokes profile validation and rendering | Split passive discovery from profile/render checks; report separate outcomes |
| extract | CLI extract calls read and exact render comparison | Preserve bytes independently of local raster equality; report unsupported profile separately |
| validate | validate_svg Python function | Public CLI, precise diagnostics and bounded syntax/render policy |
| build | create command and create/render/atomic_write functions | Shared public Core build path; new-document default 1024×1024 instead of upstream 512×512 |
| verify | inspect/_matches exact RGBA comparison | Dedicated command; renderer/version/viewport/fonts/color/alpha/method evidence |
| rebuild | update command | Source-preserving shared transaction, conflict protection and JSON result |

Current CLI reports most errors as text on stderr with exit code 2; not all commands emit JSON. Phase 1 defines a versioned structured protocol and stable exits without changing wire v1. Reuse the pinned MIT parsing/validation/render/write code through one Core; do not duplicate rendering in TypeScript. Preserve attribution when importing code. Structural audits and byte handling must be fixed before claiming support for the corresponding inputs.

## 4. Dependencies, versions and licenses

Existing package 0.2.0 declares Python >=3.10, Pillow >=11.3,<14, CairoSVG >=2.8.2,<3 and defusedxml >=0.7.1,<1. These are ranges, not the Editor's future lock. Native Cairo is separately required; Python installation alone is insufficient. Optional normalization adds tinycss2 >=1.4,<2 and Playwright ==1.64.0/Chromium; omit this optional feature from the initial editor dependency set unless explicitly adopted later.

The implementation is MIT and reusable with its copyright/license retained. Existing OSS_REVIEW records Pillow MIT-CMU, CairoSVG LGPL-3.0-or-later, defusedxml PSF and native Cairo LGPL-2.1/MPL-1.1 dual licensing. Transitive Python/native dependencies and Monaco notices require exact-version review before distribution; no dependency is relicensed by the Core's MIT license. Do not bundle native DLLs without reviewing their notices and distribution obligations.

This run used Windows x64, Python 3.13.5, Pillow 13.0.0, CairoSVG 2.9.1, defusedxml 0.7.1 and pytest 9.1.1, using an existing user venv and Cairo path. It did not install or change system Python. Python 3.11/3.12 and clean environment installation remain untested. Upstream CI is configured for Windows/macOS/Linux × Python 3.10/3.13; configuration and historical results do not prove this editor's support. Candidate editor versions remain 3.11–3.13 until P0-03 finishes.

## 5. Executed checks and observed incompatibilities

Existing implementation tests test_vector_png.py and test_spec_baseline.py: 43 passed, 1 Pillow getdata deprecation warning, 16.48 seconds. This includes roundtrip, Unicode, alpha, gradients, unsafe input, bounds, CRC, duplicates, rendering timeout and the text regression. Pinned specification unittest suite: 10 passed, 0.144 seconds. That suite checks finite fixture/normalization structure, not production conformance. Initial sandbox attempts hit temporary-directory permissions; the same checks passed with approved normal execution. Neither suite is a new Editor test suite.

A non-rendering probe called existing _read_document on all 21 pinned PNG fixtures and validate_svg on 2 declaration cases. Results are in [phase0-probes.json](../evidence/phase0-probes.json); the replay script is [phase0_probe.py](../tools/phase0_probe.py). Five of seven container-positive fixtures were accepted with exact source bytes (including bare BOM and differing preview); unsafe-svg was correctly rejected by profile policy. escaped-and-comment was incorrectly rejected because the validator searches comment text for processing-instruction syntax. Of 14 container-negative fixtures, 13 were rejected; wrong-xml-encoding was incorrectly accepted. Additional probes rejected BOM + UTF-8 declaration and accepted a non-UTF-8 declaration. These are observed compatibility gaps, not proposed specification changes. The probe does not render SVG or prove a preview match. All other container/profile requirements still need a requirement-level audit; the APNG fixture rejection alone does not prove rejection of every APNG marker.

## 6. Next actions and completion limits

[20 issues](TASKS.md) cover P0-01–P0-04, P1-01–P1-05, P2-01–P2-07 and P3-01–P3-04 with purpose, planned paths, implementation, dependencies, acceptance and tests in full English/Japanese. Fix the three observed XML gaps in P1-02 after recording them in P0-01; audit container rules before importing the shared Core. Complete dependency/OS matrix and the Custom Editor spike before closing Phase 0. Consult [architecture](ARCHITECTURE.md), [compatibility](SPEC_COMPATIBILITY.md) and [acceptance](ACCEPTANCE.md).

No stable editor, pip release, VSIX release, cross-OS real-machine acceptance or complete conformance is claimed. User decisions are required before incompatible format changes or unresolved product choices; no such change is implemented here. English/Japanese README, Phase 0, architecture, compatibility and acceptance pairs and both language sections of all 20 issues were compared section by section for full meaning, requirements, numbers, tables, code, links and limitations.

## 7. Replay commands

Use a Python environment with the recorded dependencies and native Cairo configured. Obtain trusted source snapshots at the pinned SHAs, here named baseline-implementation and baseline-spec. The implementation tests run from their own source directory. Optional tinycss2 is needed for the upstream structural normalization tests.

```text
cd baseline-implementation
python -m pytest tests/test_vector_png.py tests/test_spec_baseline.py -q -p no:cacheprovider
cd ../baseline-spec
python -m unittest discover -s tests -v
cd ../vector-png-editor
python tools/phase0_probe.py --source ../baseline-implementation/vector_png.py --fixtures ../baseline-spec/fixtures/vectors.json --output-dir ../phase0-probe-replay
python tools/check_planning.py
```

Use a fresh output directory. The probe imports trusted local implementation code, parses fixture PNGs without rendering and writes per-fixture PNGs/results.json there. Never point it at untrusted Python. The source SHA in the result identifies exact local bytes; checkout line-ending conversion can change that hash without changing the Git blob's logical source. Planning checks only validate pins, bilingual body fields, pair structure and local links; they cannot prove semantic translation parity or product correctness.



## P0-03 dependency and license verification (2026-10-28)

The dependency inventory is now published in the repository-root
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md): all nine lock pins
with license strings read from the installed distributions' metadata
(Pillow MIT-CMU, CairoSVG LGPL-3.0-or-later, defusedxml PSFL, the BSD
family cairocffi/cssselect2/tinycss2/webencodings, cffi MIT-0,
pycparser BSD-3-Clause), native Cairo (LGPL-2.1/MPL-1.1 dual, never
bundled), Monaco 0.57.0 (MIT, bundled by the extension), and the
upstream MIT provenance preserved in the Core package. A Core test
(`packages/core/tests/test_notices.py`) fails if the inventory drifts
from the lock.

Support matrix for the runtime (Core + bridge + managed environment),
by evidence rather than declaration:

| Cell | Evidence |
| --- | --- |
| Linux × Python 3.11 / 3.12 / 3.13 | core.yml CI matrix (all cells must pass for protected merges); the managed-environment manager test also runs per cell |
| macOS × Python 3.11 / 3.12 / 3.13 | core.yml CI matrix, as above |
| Windows × Python 3.11 / 3.12 / 3.13 | core.yml CI matrix, as above |
| Linux × Python 3.12 clean-room (executed 2026-10-28) | Fresh venv installed from requirements.lock + the built 0.1.0.dev3 wheel with no pre-existing packages; gradient build and verify succeeded through the bridge protocol; native Cairo 1.18.0 |
| Deviation / "upgrade" failure (executed 2026-10-28) | After installing tinycss2 1.4.0 over the lock, the version-vs-lock audit reported exactly that mismatch (installed 1.4.0 vs pinned 1.5.1) - the same comparison the environment manager uses to refuse activation |

Explicitly unsupported or unverified: Python below 3.11 or 3.14 and
later (the manager rejects them), any environment without a loadable
native Cairo (health check fails with guidance; rendering is not
claimed), source (non-wheel) installs of dependencies (the manager
requires binary wheels), and real-machine VS Code acceptance on any
OS, which remains P3-02 - CI cells are hosted evidence, not
real-machine sign-off. The earlier Phase 0 note that Python 3.11/3.12
and clean installation were untested is superseded by this section.
