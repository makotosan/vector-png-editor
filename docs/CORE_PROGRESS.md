# Initial Core implementation — 2026-10-20

[日本語](CORE_PROGRESS.ja.md)

## Delivered scope

P1-01/P1-02 now have an experimental Python package at packages/core, a public API, inspect/extract/validate JSON CLI, safe profile checks and a shared bounded CairoSVG renderer. This begins Phase 1 without declaring Phase 0 audits or the entire Phase 1 complete. build/verify/rebuild, full bridge transport/cancellation, extension, managed venv and release remain open. The Phase 0 report/evidence is a historical baseline; these new results supersede its statements that no Core exists and that the three XML gaps are still uncorrected in the new package. The original upstream implementation is unchanged.

The adapted allowlist/renderer is pinned and attributed to makotosan/vector-png. MIT notices and exact upstream fixture provenance are included in both repository/package and wheel licenses. Direct runtime versions are pinned to Pillow 13.0.0, CairoSVG 2.9.1 and defusedxml 0.7.1. This is not a complete transitive/native lock. Candidate Python metadata is >=3.11,<3.14; support is limited to executed evidence, not inferred from that declaration.

## Changes and compatibility

- SPEC §3: parser-aware XML declarations/PI handling replaces substring inspection. BOM plus UTF-8 declaration and inert comment text are accepted; non-UTF-8 encoding declarations are rejected. Extraction retains exact source bytes including CRLF, BOM and comments; no reserialization.
- SPEC §§2–4: explicit singleton/critical chunk ordering, contiguous IDAT, APNG acTL/fcTL/fdAT rejection, CRC/ending checks, IHDR fields, palette/transparency constraints, bounded single zlib streams and raster scanline/filter validation. Adam7 size calculation is implemented; broad interlace/raster coverage still needs audit.
- SPEC §§5,7: passive inspect/extract neither render nor enforce safe-svg-v1. Container-positive unsafe SVG and differing raster remain passively extractable. validate separates profile checks, actual rendering and unchecked preview equality. No automatic normalization or resource fetching.
- SPEC §6: extraction uses no-clobber atomic publication and preserves input on failure. This does not implement editor overwrite/save/concurrency transactions.

See [CLI.md](CLI.md) for exact JSON fields, exit codes and limits. The wire keyword, iTXt payload and pinned specification are unchanged; no format migration. Container results deliberately say passed-supported-checks because language-tag registry validation, ancillary payload semantics and broad decoder coverage remain open. Do not turn these finite tests into a complete-conformance claim. A font-dependent native renderer is not a universal pixel oracle.

## Validation and delivery state

Local Windows x64/Python 3.13.5: initial Core suite 55 passed in 4.49 seconds, including 21 pinned cases, three XML regressions, source bytes, malicious/profile input, explicit PNG/APNG rules, publication failure, JSON CLI, real alpha rendering and timeout. Unlike the historical Phase 0 probe, these tests exercise the new package. See subsequent verification below for the final suite/package evidence.

A nine-cell hosted CI matrix is added for Windows/macOS/Linux × Python 3.11/3.12/3.13, with actual rendering, CLI tests, wheel/sdist build and clean-venv wheel install outside the source tree. core-check aggregates every matrix cell; planning-check remains a separate documentation check. The presence of this workflow does not mean those cells passed. Current remote results must be read from the PR/Actions run. No real-machine editor acceptance exists and no pip/VSIX release is published.

The main protection was verified after GitHub reauthentication: PR required, planning-check required, branch up-to-date required, protections apply to administrators, force-push/deletion forbidden. Phase 0 PR #21 was merged through that protection; Core changes use codex/core-read-validation and a separate PR. Required checks must be reviewed as implementation CI evolves.

## Review and remaining work

Final local verification (2026-10-21 Asia/Tokyo): 62 tests passed in 4.89 seconds, adding XML/decompression resource outcomes, explicit late eXIf ordering, a positive Adam7 raster and bounded request-ID errors. Wheel and sdist built successfully with build 1.6.1, setuptools 84.2.0 and wheel 0.48.0. Clean venv installation outside the source tree passed actual packaged-worker rendering. The normal-console entry point is also checked by the packaging smoke script. Temporary-directory restrictions required approved normal execution for builds/clean installation. No system Python packages were changed; build tools were installed in the workspace. This supplements the initial 55-test result above.

P0-01/P0-02 retain full ancillary/raster/profile audit gaps; P0-03 retains native dependency/license matrix review; P0-04 retains the extension-host spike. P1-01/P1-02 are not closed merely for adding files. P1-03 covers build/verify/rebuild and file conflicts; P1-04 covers the complete TypeScript transport, schema details, cancellation, output/memory controls and environment locks; P1-05 covers complete six-command pip distribution. No changes to the storage format or unresolved product choices were made. README, architecture, acceptance, compatibility, Phase 0 pointers and new CLI/progress pairs are synchronized in full English/Japanese, reviewed for meaning as well as tables, identifiers, commands, references, numeric bounds and status.

