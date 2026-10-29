# Third-party notices and license inventory

This inventory covers everything the product depends on or bundles:
the TypeScript Core's one runtime dependency, the components copied
into the VS Code extension package, and code and fixtures adapted
from upstream projects. A test in `packages/ts-core/tests/`
(`notices.test.mjs`) guards that the resvg entry below names the
version pinned in `packages/ts-core/package.json`.

## Bundled by the VS Code extension (ships inside the VSIX)

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| @resvg/resvg-wasm | 2.6.2 | MPL-2.0 | The SVG renderer of the TypeScript Core. The package is used unmodified; its WebAssembly binary (`index_bg.wasm`, ~2.48 MB) is copied into the extension at build time by `packages/extension/scripts/copy-resvg.mjs` (to `media/resvg/`) and loaded by the bundled host code. MPL-2.0 is a file-level copyleft: the resvg source is available from the resvg project (https://github.com/RazrFalcon/resvg) and the npm package `@resvg/resvg-wasm`. |
| Monaco Editor | 0.57.0 | MIT | Copied from the npm package into the extension at build time by `packages/extension/scripts/copy-monaco.mjs`. Copyright (c) Microsoft Corporation. |

No Python interpreter, font, or native library is bundled by the
extension, and none is required at runtime: the Python Core, its
runtime dependencies (Pillow, CairoSVG, defusedxml and their
transitives) and the native Cairo library were retired with the
TypeScript migration (Phase 3, Issue #60) and are no longer part
of the product.

## Upstream provenance (adapted code and vendored fixtures)

The safe-svg-v1 allowlist and rendering adapter are adapted from
makotosan/vector-png, `vector_png.py` at commit
d00dd8800cdf6978ebf1d5c6ae61042c7fbadbc2 (blob
4828b4bb60a97704161bf71e70eaeff8fc97ef49). Copyright (c) 2026
makotosan and vector-png contributors, MIT; the full MIT text is
preserved in [LICENSE](LICENSE). The adaptation was first made in
the retired Python Core (parser-aware XML handling in place of
lexical inspection) and then ported behaviour-for-behaviour to
TypeScript in `packages/ts-core`; the original upstream code is
unchanged.

`packages/ts-core/fixtures/vectors.json` is copied without content
changes from makotosan/vector-png-spec at
8238ebdaa136f448affa53133b99ee5afde5765a, `fixtures/vectors.json`.
Copyright (c) 2026 makotosan, MIT. These 21 cases are finite
evidence, not certification. The normalization fixtures in
`packages/ts-core/fixtures/normalization/` are vendored from the
same specification repository at the pinned revision in
[spec-reference.json](spec-reference.json); see the
`PROVENANCE.md` beside them.

This product's own code is MIT (see [LICENSE](LICENSE)); that
license does not replace the terms of the components above - in
particular resvg (MPL-2.0) keeps its own obligations when the
components are redistributed together.
