# TypeScript Core (ts-core)

The TypeScript Core for vector-png-editor: the migration target
that replaces the Python Core and its CairoSVG rendering stack
(Issues #58 and #61; the go decision and its evidence are in
Issue #57).

Ported so far: the renderer, the PNG container, safe-svg-v1
validation, and svg-normalization-v1 (Phase 2, Issue #59) - and
the extension integration (Issues #58 and #59): the extension's
open/inspect, edited previews, save, export build/validate paths
and the Normalize SVG / convert paths run on this package
in-process, with the extension owning file publication policy
(its src/tsCore.ts mirrors the Python Core's writing.py
discipline). No editor feature uses the Python Core any more.
Not yet ported: the standalone verify path (render + pixel
comparison).

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
- `src/normalize.ts` — the svg-normalization-v1 normalizer,
  mirroring `normalize.py` behaviour-for-behaviour:
  `normalizeStructure(source)` (hardened parse, the closed CSS
  subset with amendments G1 letter-spacing and G3 font-family,
  cascade materialization, section 3.1 marker expansion including
  G2 curved C-segment hosts, accessibility migration with its
  recorded losses, v1 revalidation of the result, and the section
  7 conversion report in the Python report's shape and vocabulary)
  and `normalizeDocument(source, { fonts, ... })` (the gated entry
  point: the before/after render gate below, then the completed
  report; refusals throw `NormalizeRejection` carrying the failure
  report, mirroring the CoreError + details shape). The output is
  byte-identical to the Python normalizer's for the same input.
- `src/dom.ts` — the ElementTree-shaped DOM the normalizer stands
  on: a second pass over the shared scanner producing mutable
  elements with insertion-ordered attributes and text/tail
  content, plus an `ET.tostring`-exact serializer (xmlns declared
  first on the root, ` />` empty-element form, ElementTree's
  escaping rules). The normalizer's hardened preflight differs
  from validation's (its own failure codes and stage vocabulary),
  so it has its own entry points here.
- `src/pngPixels.ts` — a PNG pixel decoder (`decodePngRgba`,
  `rgbaEqual`) for the render gate's exact RGBA comparison:
  chunk walking and bounded inflate are reused from the container
  and zlib modules; unfiltering and color conversion are done
  here (8-bit fully, 16-bit by high byte, sub-byte gray/palette
  scaled; interlace refused — neither engine emits it).
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

The normalization cross-check (same harness) compares 48 cases —
the 27-case catalog, the nameplate input/expected pair, the nine
corpus SVGs and crafted edge cases. Structure-level agreement is
total: verdicts, failure codes, stages and messages, normalized
output bytes and full section 7 reports are identical on all 48.
The gated comparison is covered under "The render gate" below.

Two findings from the port, recorded plainly:

- **Validation has no canonical serialization to mirror.** The
  Core's validation path reserializes nothing (rendering.py: "no
  source reserialization"); `build` embeds the source bytes as
  supplied and `extract` returns them byte-exact. The only
  canonicalizer in the Core is the normalizer — ported in
  Issue #59 as `src/normalize.ts` over `src/dom.ts`.
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
  flagged too). The one exception is the normalization gate
  (`skipExternalReferenceScan`): its inputs have already passed
  the normalizer's section 2 inspection, which refuses every real
  external reference, so the scan would only add false refusals
  on reference-shaped text content.

The requested size must be the document's own viewport: resvg
scales uniformly (the size is applied as fitTo width), so a
request with a different aspect is refused with `render-failed`
rather than silently stretched. Engine failures also surface as
`render-failed`.

## The render gate on resvg (Issue #59)

The normalizer's before/after gate renders the original and the
normalized source with the SAME font set and requires exact RGBA
equality of the two renders — the Python gate's rule, applied
within resvg instead of within CairoSVG. Cross-engine comparison
is meaningless and is not attempted. The report's render block
names this engine (`@resvg/resvg-wasm`, version `2.6.2`); those
fields, and `color_alpha` / `text_policy`, are engine-specific
by construction and are excluded from the cross-check's report
comparison (the shared fields — fonts, background,
resource_policy, comparison, tolerances, viewport — must agree).

On the 48-case cross-check corpus the two gates' verdicts agree
on 38 cases. The other 10 are cases the Python gate passes and
the resvg gate reports as `render-mismatch` — every one traced to
a renderer-semantics difference, not a transformation difference
(the structure outputs are byte-identical in all 10):

- **CSS geometry properties (5 cases).** resvg ignores `rx`/`ry`
  declared in CSS; materializing them as attributes — what the
  transformation does — turns square corners round under resvg.
  CairoSVG applies them in both forms. (Catalog
  `rounded-diagram-arrows`; corpus `pld-timeline.svg`,
  `eu-product-framework-timeline.svg`,
  `residual-risk-reassessment-flow.svg`,
  `safety-information-traceability.svg`. In `pld-timeline.svg`,
  moving `rx` from CSS to attributes in the *original* alone
  reproduces 912 of its 965 differing pixels.)
- **Marker rasterization (3 cases).** resvg rasterizes a native
  marker and the spec's expanded `<g>` clone with slightly
  different antialiasing (edge deltas up to ~46/255 on the
  iso7010 arrowheads; 4 pixels at a small rotated arrowhead's
  tip). With marker rendering factored out of both sides, the
  before/after renders are pixel-identical. (Corpus
  `iso7010-global-alignment.svg`, `iso7010-update-cycle.svg`.)
- **Markers on `stroke="none"` hosts (2 cases) — the Issue #59
  decision.** resvg does not paint native markers on hosts whose
  computed stroke is `none` (explicit or default); CairoSVG
  paints them. The transformation mirrors Python exactly —
  markers on such hosts are expanded to clone groups like any
  other, and the clone IS painted by resvg — so the within-resvg
  gate reports a mismatch where the Cairo gate passes. This is
  recorded as a known, tested deviation (see
  `tests/normalize.test.mjs`), **not** compensated for: changing
  the output to suit one renderer would break byte parity with
  the Python normalizer. Renderer-conformance records are
  Issue #61's deferred scope.

The divergences are tagged per case in
`KNOWN_GATE_DIVERGENCES` in `tests/parity.test.mjs`, so a new
disagreement fails the cross-check instead of passing silently.

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

The normalizer suite (`tests/normalize.test.mjs`) runs without
Python: the 27-case catalog's verdicts and codes, the nameplate
golden output and report, the Python suite's cascade / CSS
rejection / marker geometry / accessibility / resource-limit
expectations baked in, the gated entry point on resvg, and the
`stroke="none"` decision tests.

Note: `node_modules` includes the resvg wasm asset (~2.5 MB);
the MPL-2.0 notice for resvg lands in THIRD_PARTY_NOTICES with
the packaging work (Issue #60).
