# TypeScript Core (ts-core)

The TypeScript Core for vector-png-editor: the migration target
that replaces the Python Core and its CairoSVG rendering stack
(Issues #58 and #61; the go decision and its evidence are in
Issue #57).

Ported so far: the renderer, the PNG container, and safe-svg-v1
validation - and the extension integration (Issue #58): the
extension's open/inspect, edited previews, save and export
build/validate paths run on this package in-process, with the
extension owning file publication policy (its src/tsCore.ts
mirrors the Python Core's writing.py discipline). Not yet
ported: svg-normalization-v1 (Phase 2, Issue #59) and the
standalone verify path (render + pixel comparison).

## Contents

- `src/render.ts` — `renderSvgToPng(source, { width, height, fonts })`:
  renders an SVG source to PNG bytes with @resvg/resvg-wasm,
  mirroring the Issue #57 spike's setup (font buffers per
  construction, system fonts off, "Noto Sans" family defaults,
  transparent background, matching the Core's Cairo gate path).
  A host whose module layout cannot resolve the wasm package from
  here (the bundled extension) supplies the binary once with
  `setWasmSource(path | bytes)` before the first render.
- `src/fonts.ts` — font ingestion: font files, with caller-stated
  family/style/weight, become the `FontBuffer` list the renderer
  consumes. Which fonts are supplied decides text rendering, so
  the choice is explicit and shared by tests and integration.
- `src/container.ts` — the PNG container, mirroring the Python
  Core's `document.py` (and the build assembly of `writing.py`):
  `parseChunks` (liberal chunk walking with CRC verification),
  `parseDocument` (full passive validation; the embedded source is
  XML-checked but not profile-checked, so a profile-unsafe source
  still extracts), `inspectDocument` (the Core's report shape),
  `extractSource` (byte-exact), `assembleVectorPng` (the build
  candidate's chunk layout: raster chunks only, source iTXt
  directly after IHDR), and `rebuildVectorPng` (the same assembly
  preserving the original iTXt payload verbatim — byte-exact for
  files the Core built).
- `src/validate.ts` — safe-svg-v1 validation mirroring the Core's
  two surfaces: `validateSource` (the accept/reject verdict;
  profile rejections throw `unsupported-profile` with the backend's
  first-error message) and `checkProfile` (every violation as a
  diagnostic with code/element/attribute/line/column/message/
  suggestion, optionally with the schema content models enforced).
- `src/xml.ts` — the bounded XML parser both of the above stand
  on, mirroring `svg.py`'s two layers (an expat-style pass applying
  the limits and prohibitions in document order, then namespace
  expansion and the SVG-root check). It is purpose-built because
  the repo has no XML parser and parity with expat's positions
  (line/column in code points from each start tag's `<`; a BOM
  counts as one column) is a property of that specific behaviour.
- `src/zlib.ts` — CRC-32 and bounded inflate with the Core's exact
  stream-end semantics rebuilt on Node's zlib (see below).
- `src/errors.ts` — `TsCoreError` (`code` + message), mirroring
  the Python Core's `CoreError` shape. Container/validation codes
  are the Core's own: `invalid-container`, `invalid-svg`,
  `unsupported-profile`, `resource-limit`, `ordinary-png`.

## Parity with the Python Core

`tests/parity.test.mjs` runs both implementations over the same
corpora and diffs verdicts, error codes, error messages and full
diagnostic lists: 141 SVG cases (the pinned catalog sources, the
nine corpus SVGs, the 27 normalization catalog inputs, the
nameplate pair, the Core tests' own cases, and crafted edge cases
for namespaces, declarations, references, positions and traversal
order) and 60 PNG cases (the 21 pinned catalog fixtures plus
constructed structural mutations), plus a Python-built file whose
TS rebuild must be byte-identical. All agree; the only tolerated
difference is message text where the Core embeds CPython's zlib /
codec error strings (e.g. "Error -3 while decompressing data…") —
the TS side reports the Core's fixed message for the same
condition, and the code always matches. The pure-TS suites encode
the Core test suites' expectations so they run without Python;
the cross-check is gated on `VECTOR_PNG_TEST_PYTHON`
(default `/tmp/buildenv/bin/python`) with the repo Core sources on
PYTHONPATH, following the repo's real-Core gating precedent.

Two findings from the port, recorded plainly:

- **Validation has no canonical serialization to mirror.** The
  Core's validation path reserializes nothing (rendering.py: "no
  source reserialization"); `build` embeds the source bytes as
  supplied and `extract` returns them byte-exact. The only
  canonicalizer in the Core is the normalizer, which is a
  separate, later port.
- **Fresh compression is not byte-identical across platforms.**
  Node's bundled zlib (1.3.2.1-motley) and CPython's zlib (1.3)
  make different match choices on some inputs (measured: the same
  SVG source compresses to 89 vs 88 bytes). `assembleVectorPng`
  therefore produces a valid vector-png whose source round-trips
  byte-exactly but whose file bytes can differ from a Python
  build's in the iTXt payload; `rebuildVectorPng` preserves the
  original payload and is byte-exact.

## Behaviour enforced before rendering

resvg alone provides neither of these, so the renderer adds both:

- **Resource caps** (code `resource-limit`, the Core's own code and
  message): integer sides, each side within 1..4096, and
  width × height ≤ 4,000,000 — the caps of the Python Core's
  `render_source` / `normalize._viewport`. resvg itself enforces
  no limits.
- **External references** (code `external-reference`): any
  `href` / `xlink:href` not starting with `#`, and any `url(...)`
  that is not a local fragment, is rejected before the engine sees
  the source. This matches the Cairo path's deny-fetch behaviour;
  resvg would otherwise drop the reference *silently*. The scan is
  a conservative raw-source scan (attributes and style content
  alike; reference-shaped text in comments or text content is
  flagged too).

The requested size must be the document's own viewport: resvg
scales uniformly (the size is applied as fitTo width), so a
request with a different aspect is refused with `render-failed`
rather than silently stretched. Engine failures also surface as
`render-failed`.

## Tests

```sh
npm install
npm test
```

The renderer suite runs the real engine (never mocked): all nine
corpus SVGs from the workspace render at the dimensions recorded
by the Issue #57 spike, the alpha properties hold exactly
(transparent stays (0,0,0,0); `fill-opacity` 0.5 yields alpha
128), the caps and external-reference rejections fire, and local
`url(#id)` references render. Renderer-conformance
re-verification against Cairo (pixel comparison, golden
regeneration) is deferred by decision and is not part of this
suite.

Note: `node_modules` includes the resvg wasm asset (~2.5 MB);
the MPL-2.0 notice for resvg lands in THIRD_PARTY_NOTICES with
the packaging work (Issue #60).
