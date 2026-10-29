// Normalizer tests for the TypeScript port of the Python Core's
// svg-normalization-v1 normalizer (packages/core .../normalize.py).
// Expectations are baked from the Python implementation and its own
// test suite (packages/core/tests/test_normalize.py) plus the
// vendored spec fixtures; the live verdict/byte/report cross-check
// against the running Python Core lives in parity.test.mjs.
//
// The render gate in these tests runs on resvg (never Cairo): the
// gate compares the before/after renders WITHIN one engine, which
// is the rule the Python gate implements with its engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NormalizeFailure,
  NormalizeRejection,
  gateInputText,
  normalizeDocument,
  normalizeStructure,
  renderGate,
} from '../src/normalize.ts';
import { renderSvgToPng } from '../src/render.ts';
import { decodePngRgba } from '../src/pngPixels.ts';
import { loadSpikeFonts } from './test-fonts.mjs';

const fixtures = fileURLToPath(
  new URL('../../core/tests/fixtures/normalization/', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const corpusDir = join(dirname(repoRoot), 'user/files');
const enc = (s) => new TextEncoder().encode(s);
const dec = (bytes) => new TextDecoder().decode(bytes);
/** Attribute values as a parser would hand them back (entities resolved). */
const attrValue = (raw) =>
  raw.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const familyOf = (svgText) => attrValue(svgText.match(/<text[^>]* font-family="([^"]*)"/)[1]);

const CATALOG = JSON.parse(await readFile(join(fixtures, 'cases.json'), 'utf8'));
const catalogCase = (id) => CATALOG.find((c) => c.id === id);

function codeOf(source) {
  try {
    normalizeStructure(source);
  } catch (error) {
    assert.ok(error instanceof NormalizeFailure, `expected NormalizeFailure, got ${error}`);
    return error.code;
  }
  assert.fail('expected normalizeStructure to reject');
}

// ----------------------------------------------------------------
// Spec fixtures (the vendored 27-case catalog)
// ----------------------------------------------------------------

test('catalog: every case yields the Python verdict and failure code', () => {
  assert.equal(CATALOG.length, 27);
  for (const fixture of CATALOG) {
    if (fixture.expect === 'accept') {
      const { report } = normalizeStructure(enc(fixture.input));
      assert.equal(report.checks.input, 'pass', fixture.id);
      assert.equal(report.checks.safe_svg, 'pass', fixture.id);
      assert.equal(report.checks.render, 'not-checked', fixture.id);
      assert.equal(report.checks.authenticity, 'not-verified', fixture.id);
    } else {
      assert.equal(codeOf(enc(fixture.input)), fixture.expect, fixture.id);
    }
  }
});

test('normalization is deterministic: same input, same bytes', () => {
  const input = enc(catalogCase('rounded-diagram-arrows').input);
  const first = normalizeStructure(input);
  const second = normalizeStructure(input);
  assert.deepEqual(second.output, first.output);
  assert.deepEqual(second.report, first.report);
});

test('nameplate golden: output bytes and report match the fixture pair', async () => {
  const input = new Uint8Array(await readFile(join(fixtures, 'nameplate.input.svg')));
  const expectedOutput = await readFile(join(fixtures, 'nameplate.expected.svg'));
  const expectedReport = JSON.parse(
    await readFile(join(fixtures, 'nameplate.expected-report.json'), 'utf8'),
  );
  const { output, report } = normalizeStructure(input);
  assert.deepEqual(Buffer.from(output), expectedOutput);
  for (const field of ['profile', 'changes', 'accessibility', 'checks', 'warnings', 'errors']) {
    assert.deepEqual(report[field], expectedReport[field], field);
  }
  assert.equal(report.input_sha256, expectedReport.input_sha256);
  assert.equal(report.changes.class_attributes, 26);
  assert.equal(report.changes.style_elements, 1);
  // The QR path data is source payload: byte-identical before/after.
  const dOf = (svg) => svg.match(/<path[^>]* id="qr"[^>]*>/)[0].match(/ d="([^"]*)"/)[1];
  assert.equal(dOf(dec(output)), dOf(dec(input)));
});

// ----------------------------------------------------------------
// Cascade (profile section 4) — outputs baked from the Python run
// ----------------------------------------------------------------

test('cascade: specificity, inheritance and group opacity', () => {
  const { output } = normalizeStructure(enc(catalogCase('cascade').input));
  assert.equal(
    dec(output),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">' +
      '<g fill="purple" opacity="0.5">' +
      '<rect id="box" width="20" height="20" fill="green" />' +
      '<rect x="30" width="20" height="20" fill="navy" />' +
      '<circle cx="90" cy="10" r="10" /></g></svg>',
  );
  assert.ok(!dec(output).includes('class=') && !dec(output).includes('style='));
});

test('source order and selector lists', () => {
  const ordered = normalizeStructure(enc(catalogCase('source-order').input));
  assert.equal(
    dec(ordered.output),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">' +
      '<rect width="20" height="20" fill="red" /></svg>',
  );
  const listed = normalizeStructure(enc(catalogCase('selector-list').input));
  assert.equal(
    dec(listed.output),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">' +
      '<rect width="20" height="20" fill="blue" />' +
      '<circle cx="60" cy="10" r="10" fill="blue" /></svg>',
  );
});

// ----------------------------------------------------------------
// CSS parser rejections (the Python suite's list, verbatim)
// ----------------------------------------------------------------

const CSS_REJECTIONS = [
  '.a .b {fill: red}', // descendant combinator
  '.a.b {fill: red}', // compound selector
  '* {fill: red}', // universal selector
  'rect[fill] {fill: red}', // attribute selector
  '@media screen {.a {fill: red}}', // at-rule
  '.a {--brand: red}', // custom property
  '.a {margin: 0}', // shorthand/unknown property
  '.a {fill: var(--x)}', // var()
  '.a {fill: currentColor}', // keyword outside the table
  '.a {fill: 10%}', // percentage
  '.a {stroke-width: 1e3}', // exponent
  '.a {letter-spacing: normal}', // G1 grammar: the keyword is not accepted
  '.a {letter-spacing: 1em}', // G1 grammar: px is the only unit
  '.a {fill: red !important}', // !important in a rule
  '.a {fill: }', // empty value
  '.a {fill red}', // missing colon
  '.a fill: red}', // missing block
];

test('CSS rejections carry unsupported-css', () => {
  for (const css of CSS_REJECTIONS) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      `<style>${css}</style><rect width="5" height="5"/></svg>`;
    assert.equal(codeOf(enc(svg)), 'unsupported-css', css);
  }
});

test('inline !important and a bad inline value are rejected', () => {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">';
  assert.equal(
    codeOf(enc(head + '<rect width="5" height="5" style="fill: red !important"/></svg>')),
    'unsupported-css',
  );
  assert.equal(
    codeOf(enc(head + '<rect width="5" height="5" style="font-size: 2em"/></svg>')),
    'unsupported-css',
  );
});

test('leading-hyphen font family is accepted and materialized (G3)', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Yu Gothic",sans-serif}</style>' +
    '<text x="1" y="9">A</text></svg>';
  const { output } = normalizeStructure(enc(svg));
  const family = familyOf(dec(output));
  assert.ok(family.startsWith('-apple-system'), family);
  assert.ok(family.includes('"Yu Gothic"'), family);
});

// ----------------------------------------------------------------
// Markers (profile section 3.1 + amendment G2)
// ----------------------------------------------------------------

const MARKER_HEAD =
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
  '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">' +
  '<path d="M0,0 L12,6 L0,12 Z" fill="black"/></marker></defs>';
const groupTransform = (svgText) => svgText.match(/<g transform="([^"]*)"/)[1];

test('marker expansion geometry (rounded-diagram-arrows)', () => {
  const { output, report } = normalizeStructure(enc(catalogCase('rounded-diagram-arrows').input));
  assert.equal(report.changes.expanded_markers, 2);
  const transforms = [...dec(output).matchAll(/<g transform="([^"]*)" fill="([^"]*)" stroke="([^"]*)"/g)];
  assert.equal(transforms.length, 2);
  assert.equal(transforms[0][1], 'translate(130 30) rotate(0) scale(2) translate(-10 -6)');
  assert.equal(transforms[0][2], '#363636');
  assert.equal(transforms[0][3], 'none');
  // Returning host ends at (40,70) heading up: tangent angle -90.
  assert.equal(transforms[1][1], 'translate(40 70) rotate(-90) scale(2) translate(-10 -6)');
  assert.ok(!dec(output).includes('marker'));
});

test('markerUnits=userSpaceOnUse does not scale with stroke-width', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
    '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse">' +
    '<path d="M0,0 L12,6 L0,12 Z" fill="black"/></marker></defs>' +
    '<path d="M5 20 H50" fill="none" stroke="black" stroke-width="4" marker-end="url(#a)"/></svg>';
  const { output, report } = normalizeStructure(enc(svg));
  assert.equal(report.changes.expanded_markers, 1);
  assert.ok(groupTransform(dec(output)).includes('scale(1)'));
});

test('unused marker definitions are validated too', () => {
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg"><defs>';
  const triangle = '<path d="M0,0 L12,6 L0,12 Z" fill="black"/>';
  const valid = `<marker id="m" markerWidth="12" markerHeight="12" orient="auto">${triangle}</marker>`;
  normalizeStructure(enc(prefix + valid + '</defs></svg>'));
  for (const definition of [
    '<marker id="m" viewBox="0 0 12 12"/>',
    valid.replace('orient="auto"', 'orient="auto-start-reverse"'),
    valid.replace('markerWidth="12"', 'markerWidth="0"'),
    valid.replace(triangle, '<circle r="5"/>'),
  ]) {
    assert.equal(codeOf(enc(prefix + definition + '</defs></svg>')), 'unsupported-css', definition);
  }
  // Lowercase closepath is the same triangle (corpus files use z).
  normalizeStructure(enc(prefix + valid.replace('Z', 'z') + '</defs></svg>'));
});

test('curved marker host expands with the cubic end tangent (G2)', () => {
  const svg =
    MARKER_HEAD +
    '<path d="M5 20 C15 20 25 20 50 20" fill="none" marker-end="url(#a)"/></svg>';
  const { output, report } = normalizeStructure(enc(svg));
  assert.equal(report.changes.expanded_markers, 1);
  assert.equal(groupTransform(dec(output)), 'translate(50 20) rotate(0) scale(1) translate(-10 -6)');
});

test('curved marker host tangent fallbacks', () => {
  // Endpoint equals the second control point: fall back to endpoint
  // minus first control point, here (30,10)-(20,10), still +x.
  const fallback =
    MARKER_HEAD + '<path d="M10 10 C20 10 30 10 30 10" fill="none" marker-end="url(#a)"/></svg>';
  assert.ok(groupTransform(dec(normalizeStructure(enc(fallback)).output)).includes('rotate(0)'));
  // Both control points coincide with the endpoint: degenerate.
  const degenerate =
    MARKER_HEAD + '<path d="M10 10 C10 10 10 10 10 10" fill="none" marker-end="url(#a)"/></svg>';
  assert.equal(codeOf(enc(degenerate)), 'unsupported-css');
  // S/Q/T segments remain rejected under G2.
  for (const d of ['M5 20 S25 20 50 20', 'M5 20 Q25 20 50 20', 'M5 20 T50 20']) {
    const svg = MARKER_HEAD + `<path d="${d}" fill="none" marker-end="url(#a)"/></svg>`;
    assert.equal(codeOf(enc(svg)), 'unsupported-css', d);
  }
});

test('marker %g formatting matches Python (angle and scale)', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
    '<marker id="a" markerWidth="7.5" markerHeight="3.25" refX="0" refY="0" orient="auto">' +
    '<path d="M0,0 L7.5,1.625 L0,3.25 Z" fill="red"/></marker></defs>' +
    '<path d="M1.5 2.25 L30.75 9.125" fill="none" stroke="black" stroke-width="0.5" marker-end="url(#a)"/></svg>';
  const { output } = normalizeStructure(enc(svg));
  assert.equal(
    dec(output),
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs />' +
      '<path d="M1.5 2.25 L30.75 9.125" fill="none" stroke="black" stroke-width="0.5" />' +
      '<g transform="translate(30.75 9.125) rotate(13.2269) scale(0.5) translate(-0 -0)" fill="red" stroke="none">' +
      '<path d="M0,0 L7.5,1.625 L0,3.25 Z" fill="red" /></g></svg>',
  );
});

// ----------------------------------------------------------------
// Spec amendments G1/G3 (synthetic cases mirroring the spec fixtures)
// ----------------------------------------------------------------

test('letter-spacing materializes from CSS (G1)', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80">' +
    '<style>.brand {font-family: sans-serif; font-size: 20px; letter-spacing: 2px; fill: #222}</style>' +
    '<text class="brand" x="10" y="40">ACME</text></svg>';
  const { output } = normalizeStructure(enc(svg));
  assert.ok(dec(output).includes('letter-spacing="2px"'));
  assert.ok(!dec(output).includes('class='));
});

test('letter-spacing presentation attribute keeps its sign (G1)', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<text x="1" y="9" letter-spacing="-0.5px">A</text></svg>';
  const { output } = normalizeStructure(enc(svg));
  assert.ok(dec(output).includes('letter-spacing="-0.5px"'));
});

test('curved marker host from the amendment cases (G2)', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" role="img" aria-labelledby="t">' +
    '<title id="t">Curved arrow</title><defs>' +
    '<marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">' +
    '<path d="M0,0 L12,6 L0,12 Z" fill="#363636"/></marker>' +
    '<style>.arrow {fill: none; stroke: black; stroke-width: 2; marker-end: url(#arrow)}</style></defs>' +
    '<path class="arrow" d="M20 90 C60 90 80 30 130 30"/></svg>';
  const { output, report } = normalizeStructure(enc(svg));
  assert.equal(report.changes.expanded_markers, 1);
  assert.equal(groupTransform(dec(output)), 'translate(130 30) rotate(0) scale(2) translate(-10 -6)');
  assert.ok(!dec(output).includes('marker'));
});

test('font-family system names materialize (G3)', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80">' +
    '<style>text {font-family: -apple-system,BlinkMacSystemFont,"Yu Gothic",sans-serif; font-size: 16px}</style>' +
    '<text x="10" y="40">Text</text></svg>';
  const { output } = normalizeStructure(enc(svg));
  const family = familyOf(dec(output));
  assert.ok(family.startsWith('-apple-system'), family);
  assert.ok(family.includes('"Yu Gothic"'), family);
});

// ----------------------------------------------------------------
// Accessibility migration (profile section 5)
// ----------------------------------------------------------------

test('accessibility migration records targets and losses', () => {
  const { output, report } = normalizeStructure(enc(catalogCase('accessibility').input));
  assert.ok(dec(output).includes('<title id="t">Example</title>'));
  const records = Object.fromEntries(report.accessibility.map((r) => [r.attribute, r]));
  assert.equal(records['aria-labelledby'].target, 'title');
  assert.equal(records['aria-describedby'].target, 'desc');
  assert.equal(records['aria-label'].loss, 'lower-priority-label');
  assert.equal(records.role.loss, 'unsupported-semantics');
  assert.equal(records['aria-live'].loss, 'unsupported-semantics');
  assert.ok(!dec(output).includes('aria-') && !dec(output).includes('role='));
  assert.ok(report.warnings.some((w) => w.code === 'accessibility-loss'));
});

test('replaced title text is recorded as a loss', () => {
  const { report } = normalizeStructure(enc(catalogCase('rounded-diagram-arrows').input));
  const replaced = report.accessibility.filter((r) => r.loss === 'replaced-text');
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].attribute, 'title');
  assert.equal(replaced[0].value, 'Public diagram');
});

// ----------------------------------------------------------------
// Resource limits (the Python suite's five cases)
// ----------------------------------------------------------------

test('resource limits carry resource-limit', () => {
  const cases = [
    new Uint8Array(1_000_001).fill(0x20),
    enc('<svg xmlns="http://www.w3.org/2000/svg">' + '<g>'.repeat(33) + '</g>'.repeat(33) + '</svg>'),
    enc('<svg xmlns="http://www.w3.org/2000/svg">' + '<rect/>'.repeat(5000) + '</svg>'),
    enc('<svg xmlns="http://www.w3.org/2000/svg"><style>' + ' '.repeat(100_001) + '</style></svg>'),
    enc(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>' +
        Array.from({ length: 1001 }, (_, i) => `.c${i}`).join(',') +
        '{fill:red}</style></svg>',
    ),
  ];
  for (const data of cases) assert.equal(codeOf(data), 'resource-limit');
});

// ----------------------------------------------------------------
// The gated entry point (profile sections 6-7), on resvg
// ----------------------------------------------------------------

test('normalizeDocument: success completes the report like the Python entry', async () => {
  const fonts = await loadSpikeFonts();
  const input = enc(catalogCase('cascade').input);
  const { output, report } = await normalizeDocument(input, { fonts });
  assert.equal(report.status, 'success');
  assert.deepEqual(report.checks, {
    input: 'pass',
    safe_svg: 'pass',
    render: 'pass',
    container: 'not-applicable',
    authenticity: 'not-verified',
  });
  assert.equal(report.output_sha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(report.render.renderer, '@resvg/resvg-wasm');
  assert.equal(report.render.comparison, 'exact');
  assert.deepEqual(report.render.viewport, [240, 120]);
});

test('normalizeDocument: a structure failure yields the failure report, no output', async () => {
  const fonts = await loadSpikeFonts();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<style>.a{margin:0}</style><rect class="a" width="5" height="5"/></svg>';
  await assert.rejects(normalizeDocument(enc(svg), { fonts }), (error) => {
    assert.ok(error instanceof NormalizeRejection);
    assert.equal(error.code, 'unsupported-css');
    assert.equal(error.report.status, 'failure');
    assert.equal(error.report.output_sha256, null);
    assert.equal(error.report.errors[0].code, 'unsupported-css');
    assert.equal(error.report.checks.render, 'not-checked');
    return true;
  });
});

test('normalizeDocument: the nameplate passes the resvg gate', async () => {
  const fonts = await loadSpikeFonts();
  const input = new Uint8Array(await readFile(join(fixtures, 'nameplate.input.svg')));
  const expected = await readFile(join(fixtures, 'nameplate.expected.svg'));
  const { output, report } = await normalizeDocument(input, { fonts });
  assert.deepEqual(Buffer.from(output), expected);
  assert.equal(report.status, 'success');
  assert.equal(report.checks.render, 'pass');
});

// ----------------------------------------------------------------
// The stroke="none" decision (Issue #59) and the gate
// accommodation (user-approved option A, 2026-10-29): the
// transformation mirrors Python exactly — markers on
// stroke="none" hosts stay an expanded clone group in the
// output, never adjusted to suit one renderer. The gate no
// longer renders the raw input as its BEFORE image (resvg
// paints no native marker on a stroke="none" host, so the raw
// before-image can never equal the clone-painting output);
// instead the before-image is the accommodated input produced
// by gateInputText — geometry winners from CSS also set as
// attributes, markers expanded by the same section 3.1 code
// path — so both sides render in forms resvg renders
// faithfully and exact RGBA equality still decides. The
// engine fact itself (resvg paints no native marker on a
// stroke="none" host, CairoSVG paints it) is unchanged and
// still asserted below.
// ----------------------------------------------------------------

const STROKE_NONE_INPUT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
  '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">' +
  '<path d="M0,0 L12,6 L0,12 Z" fill="black"/></marker></defs>' +
  '<path d="M5 20 H50" fill="none" stroke="none" marker-end="url(#a)"/></svg>';
// Byte-exact Python output for the input above (normalize_structure).
const STROKE_NONE_OUTPUT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs />' +
  '<path d="M5 20 H50" fill="none" stroke="none" />' +
  '<g transform="translate(50 20) rotate(0) scale(1) translate(-10 -6)" fill="black" stroke="none">' +
  '<path d="M0,0 L12,6 L0,12 Z" fill="black" /></g></svg>';

test('stroke="none" marker host: structure output is byte-identical to Python', () => {
  const { output, report } = normalizeStructure(enc(STROKE_NONE_INPUT));
  assert.equal(dec(output), STROKE_NONE_OUTPUT);
  assert.equal(report.changes.expanded_markers, 1);
});

test('stroke="none" marker host: resvg paints no native marker (engine fact)', async () => {
  const fonts = await loadSpikeFonts();
  const options = { fonts, width: 60, height: 40 };
  // resvg paints nothing for the native marker on a stroke="none"
  // host: the render equals the same document with the marker
  // reference removed.
  const unmarked = STROKE_NONE_INPUT.replace(' marker-end="url(#a)"', '');
  const withMarker = decodePngRgba((await renderSvgToPng(STROKE_NONE_INPUT, options)).png);
  const withoutMarker = decodePngRgba((await renderSvgToPng(unmarked, options)).png);
  assert.deepEqual(withMarker.data, withoutMarker.data);
});

test('stroke="none" marker host: the accommodated gate passes', async () => {
  const fonts = await loadSpikeFonts();
  const { output, report } = await normalizeDocument(enc(STROKE_NONE_INPUT), { fonts });
  assert.equal(dec(output), STROKE_NONE_OUTPUT);
  assert.equal(report.status, 'success');
  assert.equal(report.checks.render, 'pass');
});

// ----------------------------------------------------------------
// The gate accommodation (option A): positive cases for each of
// the three construct classes resvg cannot render in the
// input's original form, the exact shape of gateInputText, and
// a negative control proving the gate still bites.
// ----------------------------------------------------------------

const CSS_RX_INPUT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80">' +
  '<style>.round {rx: 18; fill: #363636}</style>' +
  '<rect class="round" x="10" y="10" width="80" height="60"/></svg>';

test('gate accommodation: CSS rx passes the gate (rounded-diagram-arrows class)', async () => {
  const fonts = await loadSpikeFonts();
  const minimal = await normalizeDocument(enc(CSS_RX_INPUT), { fonts });
  assert.equal(minimal.report.checks.render, 'pass');
  // The catalog case combines CSS rx with markers and an
  // accessibility migration and also passes end to end now.
  const catalog = await normalizeDocument(
    enc(catalogCase('rounded-diagram-arrows').input), { fonts },
  );
  assert.equal(catalog.report.checks.render, 'pass');
  assert.equal(catalog.report.changes.expanded_markers, 2);
});

test('gate accommodation: native-marker rasterization passes the gate (g-format class)', async () => {
  const fonts = await loadSpikeFonts();
  // The small rotated arrowhead whose native-vs-clone
  // antialiasing differed before the accommodation.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
    '<marker id="a" markerWidth="7.5" markerHeight="3.25" refX="0" refY="0" orient="auto">' +
    '<path d="M0,0 L7.5,1.625 L0,3.25 Z" fill="red"/></marker></defs>' +
    '<path d="M1.5 2.25 L30.75 9.125" fill="none" stroke="black" stroke-width="0.5" marker-end="url(#a)"/></svg>';
  const { report } = await normalizeDocument(enc(svg), { fonts });
  assert.equal(report.checks.render, 'pass');
  assert.equal(report.changes.expanded_markers, 1);
});

test('gateInputText applies exactly the two accommodations and nothing else', () => {
  // (1) The CSS geometry winner is also set as an attribute;
  // the paint declaration stays in CSS, unmaterialized.
  const rxGate = gateInputText(enc(CSS_RX_INPUT));
  assert.match(rxGate, /<rect[^>]* rx="18" \/>/);
  assert.ok(rxGate.includes('<style>.round {rx: 18; fill: #363636}</style>'), rxGate);
  assert.ok(!rxGate.includes('fill="#363636"'), rxGate);
  // (2) Markers are expanded in the gate input by the same code
  // path, and marker-end is consumed everywhere.
  const markerGate = gateInputText(enc(STROKE_NONE_INPUT));
  assert.ok(
    markerGate.includes('<g transform="translate(50 20) rotate(0) scale(1) translate(-10 -6)"'),
    markerGate,
  );
  assert.ok(!markerGate.includes('marker-end'), markerGate);
  // A document using neither construct is only re-serialized:
  // its CSS is byte-preserved and nothing is materialized.
  const plain =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
    '<style>.a {fill: red}</style><rect class="a" width="20" height="20"/></svg>';
  const plainGate = gateInputText(enc(plain));
  assert.ok(plainGate.includes('<style>.a {fill: red}</style>'), plainGate);
  assert.ok(!plainGate.includes('fill="red"'), plainGate);
});

test('render gate negative control: a hand-broken output still mismatches', async () => {
  const fonts = await loadSpikeFonts();
  const input = enc(catalogCase('cascade').input);
  const genuine = normalizeStructure(input);
  const okReport = normalizeStructure(input).report;
  await renderGate(input, genuine.output, okReport, { fonts });
  assert.equal(okReport.checks.render, 'pass');
  const brokenText = dec(genuine.output).replace('fill="green"', 'fill="red"');
  assert.notEqual(brokenText, dec(genuine.output));
  const brokenReport = normalizeStructure(input).report;
  await assert.rejects(renderGate(input, enc(brokenText), brokenReport, { fonts }), (error) => {
    assert.ok(error instanceof NormalizeFailure);
    assert.equal(error.code, 'render-mismatch');
    return true;
  });
  assert.equal(brokenReport.checks.render, 'mismatch');
});

// ----------------------------------------------------------------
// The corpus, end to end: all nine user corpus SVGs pass the
// gated normalization (structure + gate), matching the Python
// Core's all-pass result. Gated on the corpus being present,
// following the parity suite's precedent.
// ----------------------------------------------------------------

const corpusTest = existsSync(corpusDir) ? test : test.skip;

corpusTest('all nine corpus SVGs pass normalizeDocument end-to-end', async () => {
  const fonts = await loadSpikeFonts();
  const names = (await readdir(corpusDir)).filter((n) => n.endsWith('.svg')).sort();
  assert.equal(names.length, 9);
  for (const name of names) {
    const source = new Uint8Array(await readFile(join(corpusDir, name)));
    const { report } = await normalizeDocument(source, { fonts });
    assert.equal(report.status, 'success', name);
    assert.equal(report.checks.render, 'pass', name);
  }
});
