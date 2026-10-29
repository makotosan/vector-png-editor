# TypeScript Core (ts-core)

The TypeScript Core for vector-png-editor: the migration target
that replaces the Python Core's CairoSVG rendering stack with
@resvg/resvg-wasm (Issues #58 and #61; the go decision and its
evidence are in Issue #57).

This package currently contains **only the first slice**: the
renderer module. Everything else — the PNG container work,
safe-svg-v1 validation, normalization, and the extension
integration — is not ported yet and still lives in the Python
Core (`packages/core`) and the bridge (`packages/bridge`).

## Contents

- `src/render.ts` — `renderSvgToPng(source, { width, height, fonts })`:
  renders an SVG source to PNG bytes with resvg-wasm, mirroring
  the Issue #57 spike's setup (font buffers per construction,
  system fonts off, "Noto Sans" family defaults, transparent
  background, matching the Core's Cairo gate path).
- `src/fonts.ts` — font ingestion: font files, with caller-stated
  family/style/weight, become the `FontBuffer` list the renderer
  consumes. Which fonts are supplied decides text rendering, so
  the choice is explicit and shared by tests and integration.
- `src/errors.ts` — `TsCoreError` (`code` + message), mirroring
  the Python Core's `CoreError` shape.

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

The suite runs the real engine (never mocked): all nine corpus
SVGs from the workspace render at the dimensions recorded by the
Issue #57 spike, the alpha properties hold exactly (transparent
stays (0,0,0,0); `fill-opacity` 0.5 yields alpha 128), the caps
and external-reference rejections fire, and local `url(#id)`
references render. Renderer-conformance re-verification against
Cairo (pixel comparison, golden regeneration) is deferred by
decision and is not part of this suite.

Note: `node_modules` includes the resvg wasm asset (~2.5 MB);
the MPL-2.0 notice for resvg lands in THIRD_PARTY_NOTICES with
the packaging work (Issue #60).
