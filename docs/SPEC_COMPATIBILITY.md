# Specification compatibility record

[日本語](SPEC_COMPATIBILITY.ja.md)

## Baseline and claims

English SPEC.md at [8238ebdaa136f448affa53133b99ee5afde5765a](https://github.com/makotosan/vector-png-spec/tree/8238ebdaa136f448affa53133b99ee5afde5765a) is normative; SPEC.ja.md is a full informative translation. See [spec-reference.json](../spec-reference.json) and [implementation-reference.json](../implementation-reference.json). This records historical upstream research plus current experimental Core work in [CORE_PROGRESS.md](CORE_PROGRESS.md) and [CLI.md](CLI.md). The new Core resolves the three XML gaps, separates passive discovery from profile/rendering and adds explicit PNG/raster checks; ancillary/language/raster audits remain open. No complete conformance is claimed. Wire v1 is unchanged. Existing files need no format migration.

## Historical upstream requirement status

These rows describe the original upstream baseline. For the new package, the three XML regressions are fixed; passive reads and shared rendering are implemented. Current limits, supported checks, tests and remaining audits are recorded in [CORE_PROGRESS.md](CORE_PROGRESS.md), not inferred from these historical rows.

| Requirement | Evidence / remaining work |
| --- | --- |
| SPEC §2 PNG validity/order/CRC/APNG | Existing CRC, duplicate keyword, ending and raster tests pass. Full ordering, unknown critical chunks, all APNG markers and raster subset remain unaudited; one APNG fixture rejection is insufficient. P0-01/P1-01/P1-02. |
| SPEC §3 compressed iTXt/UTF-8 | 21-fixture passive probe accepted basic/source-after-idat/language-fields/bare BOM with exact source. Rejected wrong type/compression/method/trailing zlib/invalid UTF-8. Broader zlib/language constraints remain to audit. |
| SPEC §3 XML source | Observed wrong-xml-encoding accepted, escaped-and-comment rejected, BOM+UTF-8 declaration rejected. Correct these three gaps without weakening security. No XML reserialization or automatic normalization. P0-01/P1-02. |
| SPEC §4 finite limits/outcomes | Numeric SVG/PNG/pixel limits match baseline; upstream chunk limit 10,000. Profile: 5000 elements/depth 32/attribute length 100,000. Structured error separation and allocation coverage require audit. P1-02/P1-04. |
| SPEC §5 safe-svg-v1 | Existing allowlist/resource restrictions and unsafe-input tests provide finite evidence. Profile rejection differs from container-invalid. No DOM execution/discovery, no resource fetching. Full profile audit pending P0-02. |
| SPEC §6 source/preview transaction | Existing create/update regenerate and atomic_write publishes; editor byte-preserving save, conflict races, backup and crash/failure handling not implemented. P1-03/P2-04/P2-06. |
| SPEC §7 preview integrity | Existing exact local CairoSVG RGBA comparison is stricter policy. Different-preview is container-valid and accepted by passive probe; no render performed there. Report engine/version/viewport/fonts/color/alpha/method or not checked. No authenticity or universal pixel equality. |
| SPEC §8 identification/evolution | Use PNG signature/content and vector-png.svg rather than mandatory suffix/profile field. Editor product v1.0 is not a new wire version. Incompatible changes require separate upstream proposal and user judgment. |

## Evidence boundaries

[Phase 0](PHASE0.md) records Windows/Python 3.13: 43 implementation tests and 10 pinned structural tests passed; 21 container probes plus 2 XML probes reveal the gaps above. [Raw probe results](../evidence/phase0-probes.json) deliberately retain accepted/rejected outcomes instead of calling them a conformance pass count. Unsafe SVG may be container-valid; preview equality is independent. Python 3.11/3.12, full OS support, extension-host behavior and all real-machine acceptance remain unverified. Optional upstream normalization is not automatically imported into this editor. Record every later change with spec sections, fixtures, results, compatibility impact and full English/Japanese updates.


Current writer scope (SPEC §§3–7): unchanged UTF-8 source in canonical compressed iTXt, IHDR viewport generation, validated candidate and exact local RGBA8 verification, explicit overwrite/backup and cooperative conflicts are implemented. Arbitrary external-writer races, crash durability and editor saves remain open; see [WRITING.md](WRITING.md). No wire/pin change or complete-conformance claim.

Bridge follow-up: protocol-1 stdin requests, inline exact source, strict bounded decoding, TypeScript orchestration/stale-result rejection and read-only environment health checks are implemented in 0.1.0.dev3. See [BRIDGE.md](BRIDGE.md). No file-format, renderer policy, specification pin or writer concurrency change; P1-04 native/transitive locking, graceful worker cancellation, bounded renderer output and upgrade/rollback remain open.

Managed-environment follow-up: a separate TypeScript API now installs the reviewed Python application-dependency version lock, health-checks new immutable venvs, activates them atomically and supports validated rollback; see [INSTALL.md](INSTALL.md). Native/artifact hashing, VS Code setup/dirty-edit integration and full renderer controls remain open. This does not change wire v1, the specification pin, the Core writer or default standalone pip dependency behavior.
