# safe-svg-v1 generation rules for AI callers

Generated from `schemas/safe-svg-v1.policy.yaml` by
`tools/generate_safe_svg_schemas.py`. Do not edit by hand. These rules
constrain direct SVG XML generation (Issue #22, method A): generate
only what is listed here, then validate before any file is written.

## Hard rules

- Root is one `<svg>` in the SVG namespace (`http://www.w3.org/2000/svg`).
  The document is UTF-8, at most 1000000 bytes,
  5000 elements, depth 32.
- Allowed elements only: `svg`, `g`, `defs`, `title`, `desc`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `linearGradient`, `radialGradient`, `stop`, `clipPath`.
- Allowed attributes only: `id`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `width`, `height`, `viewBox`, `preserveAspectRatio`, `d`, `points`, `transform`, `fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-width`, `stroke-opacity`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `stroke-dasharray`, `stroke-dashoffset`, `opacity`, `font-family`, `font-size`, `font-weight`, `font-style`, `text-anchor`, `dominant-baseline`, `dx`, `dy`, `rotate`, `offset`, `stop-color`, `stop-opacity`, `gradientUnits`, `gradientTransform`, `spreadMethod`, `fx`, `fy`, `fr`, `clip-path`, `clipPathUnits`.
  Unknown elements, attributes (including `class` and `style`), or
  values are rejected, never silently dropped.
- No DTD, entities, processing instructions, scripts, event-handler
  attributes, hyperlinks, images, `use`, `foreignObject`, animation,
  CSS, or external resources of any kind.
- Attribute values must not contain any of
  `\@{};<>` or control characters
  other than tab/newline/carriage return, and are at most
  100000 code points.
- `id` values match `[A-Za-z_][A-Za-z0-9_.-]*` and are unique.
- The only URL form is `url(#id)`, and only on `fill`, `stroke`
  (target: a local `linearGradient` or `radialGradient`) and
  `clip-path` (target: a local `clipPath`). No references inside
  gradient or clipPath definitions.
- Numbers, colors, path data and transforms are checked by the
  bounded renderer at build time; keep them simple and finite.

## Structure (content models)

- `svg` may contain: svg, g, defs, title, desc, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, linearGradient, radialGradient, clipPath
- `g` may contain: svg, g, defs, title, desc, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, linearGradient, radialGradient, clipPath
- `defs` may contain: svg, g, defs, title, desc, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, linearGradient, radialGradient, clipPath
- `title` may contain: no child elements
- `desc` may contain: no child elements
- `path` may contain: no child elements
- `rect` may contain: no child elements
- `circle` may contain: no child elements
- `ellipse` may contain: no child elements
- `line` may contain: no child elements
- `polyline` may contain: no child elements
- `polygon` may contain: no child elements
- `text` may contain: tspan
- `tspan` may contain: tspan
- `linearGradient` may contain: stop, title, desc
- `radialGradient` may contain: stop, title, desc
- `stop` may contain: no child elements
- `clipPath` may contain: svg, g, defs, title, desc, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, linearGradient, radialGradient, clipPath

## Workflow

1. Generate the SVG XML directly; no JSON intermediate form.
2. Validate: `vector-png-editor validate <file.svg> --profile safe-svg-v1`
   and fix every diagnostic (severity/code/element/attribute/line/
   column/message/suggestion) before proceeding.
3. Only after validation passes, build or overwrite the PNG through
   the revision-checked CLI workflow (docs/CODEX.md). A failing SVG
   must never overwrite an existing vector-png.
