# Third-party notices and license inventory

This inventory covers everything the product depends on or bundles:
the Python runtime dependencies pinned in [requirements.lock](requirements.lock),
the native Cairo library, the editor code bundled by the VS Code
extension, and code adapted from upstream projects. License strings
below were read from the installed distributions' package metadata
during the P0-03 verification (clean venv, Python 3.12, 2026-10-28);
`packages/core/tests/test_notices.py` guards that every lock pin
appears here at its pinned version.

## Python runtime dependencies (pinned, not bundled with the Core wheel)

| Package | Version | License | Role |
| --- | --- | --- | --- |
| vector-png-editor-core | 0.1.0.dev3 | MIT | This product's Core (see provenance below) |
| Pillow | 13.0.0 | MIT-CMU | PNG raster decode/encode |
| CairoSVG | 2.9.1 | LGPL-3.0-or-later | SVG rendering to the preview raster |
| defusedxml | 0.7.1 | PSFL (Python Software Foundation License) | Hardened XML parsing |
| cairocffi | 1.7.1 | BSD (3-clause, per package classifier) | Python bindings for native Cairo |
| cffi | 2.1.1 | MIT-0 | FFI used by cairocffi |
| cssselect2 | 0.10.1 | BSD (3-clause, per package classifier) | CSS selection for CairoSVG |
| tinycss2 | 1.5.1 | BSD (3-clause, per package classifier) | CSS parsing for CairoSVG |
| pycparser | 3.12 | BSD-3-Clause | C parsing for cffi |
| webencodings | 0.6.1 | BSD (3-clause, per package classifier) | Encoding tables for tinycss2 |

The managed environment installs exactly these versions and rejects
an environment whose installed versions differ (see docs/INSTALL.md).
The lock is a version lock, not a hash lock for dependency wheels.

## Native libraries (installed separately, never bundled)

| Library | License | Notes |
| --- | --- | --- |
| Cairo (libcairo) | LGPL-2.1 / MPL-1.1 dual | System library loaded by cairocffi at render time. Verified locally with Cairo 1.18.0 on Linux. The product installs no native library; setup reports a missing Cairo as a health-check failure with platform guidance. |

## Bundled by the VS Code extension

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| Monaco Editor | 0.57.0 | MIT | Copied from the npm package into the extension at build time by `packages/extension/scripts/copy-monaco.mjs`. Copyright (c) Microsoft Corporation. |

No Python interpreter, font, or native library is bundled by the
extension.

## Upstream provenance (adapted code)

The safe-svg-v1 allowlist and rendering adapter in the Core are
adapted from makotosan/vector-png (MIT), and the conformance vectors
come from makotosan/vector-png-spec (MIT). Exact commits, blob hashes
and the preserved MIT texts are recorded in
[packages/core/THIRD_PARTY_NOTICES.md](packages/core/THIRD_PARTY_NOTICES.md)
and [packages/core/LICENSE](packages/core/LICENSE), which ship inside
the Core wheel. This product's own code is MIT (see the package
LICENSE); the MIT license of this product does not replace the terms
of the dependencies above - in particular CairoSVG (LGPL-3.0-or-later)
and native Cairo (LGPL-2.1/MPL-1.1) keep their own obligations when
the components are redistributed together.
