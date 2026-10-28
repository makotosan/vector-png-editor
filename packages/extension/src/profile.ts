// safe-svg-v1 profile data mirrored from the Python Core
// (packages/core/src/vector_png_editor/_backend.py: TAGS / ATTRS).
// A unit test parses the Core source and fails if these lists drift.
// The Core remains the authoritative validator; this data drives editor
// completion and advisory diagnostics only.
export const SAFE_SVG_ELEMENTS: readonly string[] = [
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'linearGradient',
  'radialGradient', 'stop', 'clipPath',
];
export const SAFE_SVG_ATTRIBUTES: readonly string[] = [
  'id', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'viewBox', 'preserveAspectRatio', 'd', 'points',
  'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'font-family',
  'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'dx', 'dy', 'rotate', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'fx', 'fy', 'fr', 'clip-path', 'clipPathUnits',
];
export const MAX_SVG_BYTES = 1_000_000;
export const MAX_ELEMENTS = 5_000;
