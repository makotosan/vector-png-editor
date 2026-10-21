# Experimental writing and preview verification

[日本語](WRITING.ja.md)

## Commands and independent results

Core 0.1.0.dev2 adds build, verify and rebuild to inspect, extract and validate. No wire-format or specification-pin change. The VS Code editor, managed venv and stable release remain unimplemented. P1-03 is partial: the commands exist, but strict concurrency with arbitrary external writers and editor acceptance remain open.

```text
vector-png-editor build original.svg output.png --width 1024 --height 1024
vector-png-editor verify output.png
vector-png-editor rebuild output.png rebuilt.png
vector-png-editor rebuild output.png output.png --overwrite --expected-sha256 SHA256_FROM_INSPECT
```

build takes unchanged UTF-8 source bytes, validates safe-svg-v1 and renders at the explicit output viewport (default 1024×1024). It writes one compressed iTXt with empty language/translated keyword before IDAT, retaining BOM, XML declaration, Unicode, comments and CRLF. rebuild reads a bounded snapshot and uses its embedded source and IHDR viewport; no SVG reserialization. Both discard optional PNG metadata, retaining raster-essential chunks only. Ordinary PNG has no source to rebuild or verify and exits 7.

Before publication, both writers re-read the candidate in memory through the supported container checks, compare the embedded source bytes, render again and require exact RGBA8 equality. A generated mismatch exits 12 without publication. verify performs the same local comparison without writing. The public Python verify_document API returns preview=match or mismatch. CLI verify mismatch returns ok=false, error.code=render-mismatch and the full comparison report in error.details; there is no top-level result on failure. Existing JSON envelopes remain protocol 1; the schema adds these commands, error codes and optional error.details.

Comparison reports container=passed-supported-checks, profile=safe-svg-v1, profile_check=passed, renderer=CairoSVG, renderer_version, viewport, fonts=host-selected, color_alpha=CairoSVG default; transparent background, text_policy=grayscale antialias; hint style/metrics disabled, comparison=exact-rgba8, authenticity=not-checked, PNG/source SHA-256 and source byte count. PNG raster conversion uses Pillow RGBA8, including downconversion of higher-depth input; it does not compare original high-bit-depth samples or apply ICC color management. A mismatch is not malformed-container evidence, a cross-engine equivalence test or proof of tampering. The existing ancillary/language/raster audit limits remain.

## Publication and conflict boundaries

New outputs use a same-directory temporary file, flush/fsync and atomic no-clobber hard link. Existing outputs, including concurrently created ones, are never silently replaced. The filesystem must support hard links; there is no unsafe copy fallback. Handled failures and interruption before publication clean the temporary file. Generated source and raster are published together.

Overwrite requires both --overwrite and a lowercase 64-hex --expected-sha256 token obtained from inspect of the destination. A differing token or existing destination lock exits 13 (conflict). Supplying only one overwrite option or an invalid token exits 2. Symlink destinations are refused. Writers exclusively create OUTPUT.vector-png.lock, check the existing destination, stage/fsync the candidate, save a separate fsynced original snapshot at OUTPUT.UUID.backup, check the destination again, then use atomic os.replace. Success returns the retained backup path; new-file success returns backup=null. Backup files also remain after later conflicts/failures and must be retained/reviewed by the caller. They contain original source and artwork; no automatic backup deletion policy exists.

This lock coordinates Core writers using the same destination path. It is not an operating-system compare-and-swap primitive: an external application ignoring the lock can write between the final check and replacement, change files through aliases or modify an inode through an open handle. Strict preservation of every such concurrent version is not guaranteed. Use Save As for externally active files. The independent backup protects the captured original even from later in-place writes; it does not close that race. Hostile directories/path swaps, file permission/ownership preservation, stale-lock recovery after process termination and crash durability across directory updates are not implemented. A stale lock fails closed; inspect ongoing processes and recover manually. P1-03/P2-06 remain open for stronger platform-specific concurrency and editor tests.

## Errors, limits and evidence

Additional exits: 12 render-mismatch; 13 conflict; 14 cancelled (handled KeyboardInterrupt). These supplement the existing [CLI contract](CLI.md). Forceful process termination is not handled cancellation and can leave a temporary file or stale lock. A cancellation occurring after the atomic publication boundary may already have committed a complete file. Bridge cancellation and bounded subprocess output remain P1-04. Rendering uses the existing 20-second subprocess timeout and native dependency/security limitations, with no OS sandbox or hard memory quota. Source/PNG/pixel/complexity limits remain unchanged. Safe-profile rejection, rendering timeout, simulated disk failure, candidate mismatch and interruption before publication are tested for original preservation.

Tests cover Unicode/BOM/CRLF source roundtrip, build/verify/rebuild, differing raster with separate container/comparison outcomes, explicit overwrite/backup, stale revision, cooperative lock, a concurrently created new output, an external change detected before replacement and ordinary PNG rejection. Clean-wheel smoke coverage exercises all six console commands outside the source tree. Hosted CI retains all nine OS/Python cells; Core CI now runs on PRs and main pushes to avoid duplicate feature-branch push/PR checks with the same required-check name. Current execution evidence is recorded in [CORE_PROGRESS.md](CORE_PROGRESS.md); workflow presence is not a passing result. Full format conformance, arbitrary-writer concurrency and real-machine editor acceptance are not claimed.
