// safe-svg-v1 validation tests for the TS port. Expectations are
// transcribed from the Python Core's own suites (test_core.py's
// safety/resource tables and test_safe_svg_schema.py's SC cases);
// the exhaustive verdict/message/diagnostic equality check against
// the running Python Core is tests/parity.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProfile, validateSource } from '../src/validate.ts';
import { parseSource } from '../src/xml.ts';
import { TsCoreError } from '../src/errors.ts';

const enc = (s) => new TextEncoder().encode(s);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="2" fill="red"/></svg>';

function validateCode(source) {
  try {
    validateSource(source);
    return null;
  } catch (error) {
    assert.ok(error instanceof TsCoreError, `expected TsCoreError, got ${error}`);
    return error.code;
  }
}

function validateError(source) {
  try {
    validateSource(source);
    return null;
  } catch (error) {
    return error;
  }
}

// The Core's test_safety_and_xml_outcomes table (test_core.py).
const SAFETY_CASES = [
  ['<?xml version="1.0" encoding="ISO-8859-1"?>' + SVG, 'invalid-svg'],
  [SVG + '<?real pi?>', 'invalid-svg'],
  ['<!DOCTYPE svg [<!ENTITY x "boom">]>' + SVG, 'invalid-svg'],
  [SVG.replace('red', 'url(https://example.com/)'), 'unsupported-profile'],
  [SVG.replace('<rect', '<image'), 'unsupported-profile'],
  [SVG.replace('fill="red"', 'style="fill:red"'), 'unsupported-profile'],
  [SVG.replace('fill="red"', 'onload="run()"'), 'unsupported-profile'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><use href="#x"/></svg>', 'unsupported-profile'],
];
for (const [source, code] of SAFETY_CASES) {
  test(`validate rejects with ${code}: ${source.slice(0, 48)}…`, () => {
    assert.equal(validateCode(enc(source)), code);
  });
}

test('validate rejects non-UTF-8 and NUL sources as invalid-svg', () => {
  assert.equal(validateCode(new Uint8Array([0xff])), 'invalid-svg');
  assert.equal(validateCode(enc('\x00' + SVG)), 'invalid-svg');
});

test('validate accepts the plain conforming source and reports the Core shape', () => {
  const report = validateSource(enc(SVG));
  assert.deepEqual(report, {
    xml: 'valid',
    profile: 'safe-svg-v1',
    profile_check: 'passed',
    render: 'not-checked',
    svg_bytes: enc(SVG).length,
  });
});

// The Core's resource-limit cases (test_core.py
// test_independent_resource_outcomes + the safety table).
const OPEN = '<svg xmlns="http://www.w3.org/2000/svg">';
test('validate enforces the element, depth, attribute and byte limits', () => {
  assert.equal(validateCode(enc(OPEN + '<g/>'.repeat(5000) + '</svg>')), 'resource-limit');
  assert.equal(validateCode(enc(OPEN + '<g>'.repeat(33) + '</g>'.repeat(33) + '</svg>')), 'resource-limit');
  assert.equal(
    validateCode(enc(OPEN + `<g id="${'a'.repeat(100_001)}"/></svg>`)),
    'resource-limit',
  );
  assert.equal(validateCode(enc(' '.repeat(1_000_001))), 'resource-limit');
  // Exactly at the limits is fine.
  assert.equal(validateCode(enc(OPEN + '<g/>'.repeat(4999) + '</svg>')), null);
});

// First-error messages mirror the backend's strings.
const MESSAGE_CASES = [
  [SVG.replace('<rect', '<image'), 'Unsupported SVG element: {http://www.w3.org/2000/svg}image'],
  [SVG.replace('<rect', '<rect foo="1"'), 'Unsupported SVG attribute: foo'],
  [
    '<svg xmlns="http://www.w3.org/2000/svg"><g id="a"/><g id="a"/></svg>',
    'Invalid or duplicate SVG id',
  ],
  [
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/x)"/></svg>',
    'Only local paint/clip URLs are supported',
  ],
  [
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#missing)"/></svg>',
    'Invalid local resource reference',
  ],
  [
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient><clipPath id="c"><rect clip-path="url(#c)"/></clipPath></defs></svg>',
    'References inside resource definitions are unsupported',
  ],
  [SVG.replace('fill="red"', 'fill="a;b"'), 'Unsupported attribute syntax'],
];
for (const [source, message] of MESSAGE_CASES) {
  test(`validate message: ${message}`, () => {
    const error = validateError(enc(source));
    assert.equal(error.code, 'unsupported-profile');
    assert.equal(error.message, message);
  });
}

test('parse-level messages mirror the Core strings', () => {
  assert.equal(validateError(enc('<!DOCTYPE svg>' + SVG)).message,
    'DTD, entities and processing instructions are forbidden');
  assert.equal(
    validateError(enc('<?xml version="1.0" encoding="ISO-8859-1"?>' + SVG)).message,
    'XML declaration must use UTF-8',
  );
  assert.equal(validateError(enc('<html/>')).message,
    'Root must be SVG in the SVG namespace');
  assert.equal(validateError(enc('<svg')).message, 'Malformed XML');
  assert.equal(validateError(new Uint8Array([0xff])).message, 'SVG is not UTF-8');
});

// --- profile_check diagnostics (test_safe_svg_schema.py SC cases) ---

const VALID =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
  '<stop offset="1" stop-color="#00f"/></linearGradient>' +
  '<clipPath id="c"><rect width="8" height="16"/></clipPath></defs>' +
  '<g clip-path="url(#c)"><rect width="16" height="16" fill="url(#g)"/>' +
  '<text x="1" y="9" font-size="6">A<tspan dx="1">B</tspan></text></g></svg>';

const codes = (source, options) =>
  checkProfile(enc(source), options).map((d) => d.code);

test('SC01/SC08: the schema-valid artwork has no diagnostics, strict or not', () => {
  assert.deepEqual(checkProfile(enc(VALID), { strictStructure: true }), []);
  assert.deepEqual(checkProfile(enc(VALID)), []);
  assert.equal(validateCode(enc(VALID)), null);
});

test('SC02: an undefined element is an unsupported-element diagnostic', () => {
  const bad = VALID.replace('<rect width="16"', '<image width="16"');
  assert.ok(codes(bad, { strictStructure: true }).includes('unsupported-element'));
});

test('SC03: class is an unsupported attribute with the Core suggestion and position', () => {
  const bad = VALID.replace('<g clip-path', '<g class="hero" clip-path');
  const diags = checkProfile(enc(bad), { strictStructure: true });
  const hit = diags.find((d) => d.code === 'unsupported-attribute' && d.attribute === 'class');
  assert.ok(hit);
  assert.match(hit.suggestion, /presentation attributes/);
  assert.equal(hit.line, 1);
  assert.equal(hit.severity, 'error');
});

test('SC04: a declaration-shaped value is a forbidden-value diagnostic', () => {
  const bad = VALID.replace('fill="url(#g)"', 'fill="red;behavior:url(x)"');
  assert.ok(codes(bad, { strictStructure: true }).includes('forbidden-value'));
});

test('SC05: content models bind only in strict mode', () => {
  const bad =
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
    '<g><stop offset="0"/></g></svg>';
  assert.ok(codes(bad, { strictStructure: true }).includes('structure'));
  assert.deepEqual(checkProfile(enc(bad)), []);
});

test('SC06: external and unresolved references are diagnosed', () => {
  const external = VALID.replace('fill="url(#g)"', 'fill="url(https://example.com/x.svg#g)"');
  assert.ok(codes(external, { strictStructure: true }).includes('invalid-url'));
  const missing = VALID.replace('fill="url(#g)"', 'fill="url(#missing)"');
  assert.ok(codes(missing, { strictStructure: true }).includes('unresolved-reference'));
});

test('SC07: script elements and event attributes are diagnosed', () => {
  const withScript = VALID.replace('</svg>', '<script>alert(1)</script></svg>');
  assert.ok(codes(withScript, { strictStructure: true }).includes('unsupported-element'));
  const withOnclick = VALID.replace('<rect width="8"', '<rect onclick="x()" width="8"');
  const diags = checkProfile(enc(withOnclick), { strictStructure: true });
  const hit = diags.find((d) => d.code === 'unsupported-attribute' && d.attribute === 'onclick');
  assert.ok(hit);
  assert.equal(hit.suggestion, 'event-handler attributes are not supported');
});

test('reference typing and id rules produce their diagnostics', () => {
  const wrongType = VALID.replace('fill="url(#g)"', 'fill="url(#c)"');
  assert.ok(codes(wrongType).includes('wrong-reference-type'));
  const duplicate =
    '<svg xmlns="http://www.w3.org/2000/svg"><g id="a"/><g id="a"/></svg>';
  assert.ok(codes(duplicate).includes('duplicate-id'));
  const invalidId =
    '<svg xmlns="http://www.w3.org/2000/svg"><g id="1bad"/></svg>';
  assert.ok(codes(invalidId).includes('invalid-id'));
  const inDefinition =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
    '<clipPath id="c"><rect width="4" height="4"/></clipPath>' +
    '<clipPath id="d"><rect width="4" height="4" clip-path="url(#c)"/></clipPath>' +
    '</defs></svg>';
  assert.ok(codes(inDefinition).includes('reference-in-definition'));
});

test('diagnostics stop at the Core cap of 50', () => {
  const bad =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    Array.from({ length: 60 }, (_, i) => `<g bad${i}="1"/>`).join('') +
    '</svg>';
  assert.equal(checkProfile(enc(bad)).length, 50);
});

test('diagnostic positions count code points like expat', () => {
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg"><text>';
  const closing = '</text><image/></svg>';
  const twoByte = checkProfile(enc(prefix + 'éé' + closing));
  assert.equal(twoByte[0].line, 1);
  assert.equal(twoByte[0].column, 55);
  const astral = checkProfile(enc(prefix + '\u{1F600}' + closing));
  assert.equal(astral[0].column, 54);
  const bom = checkProfile(
    new Uint8Array([0xef, 0xbb, 0xbf, ...enc(prefix + closing)]),
  );
  assert.equal(bom[0].column, 54); // BOM counts as one column
  const crlf = checkProfile(enc(prefix.replace('><text>', '>\r\n<text>') + '\r' + closing));
  assert.equal(crlf[0].line, 3);
});

test('parseSource returns the namespace-expanded tree', () => {
  const { root } = parseSource(enc(VALID));
  assert.equal(root.ns, 'http://www.w3.org/2000/svg');
  assert.equal(root.local, 'svg');
  assert.equal(root.children[0].local, 'defs');
});

// The normalization fixture pair: the input is profile-unsafe, the
// expected output validates clean.
test('nameplate fixture pair: input rejected, expected accepted', async () => {
  const fixtures = fileURLToPath(
    new URL('../fixtures/normalization/', import.meta.url),
  );
  const input = await readFile(join(fixtures, 'nameplate.input.svg'));
  const expected = await readFile(join(fixtures, 'nameplate.expected.svg'));
  assert.equal(validateCode(new Uint8Array(input)), 'unsupported-profile');
  assert.equal(validateCode(new Uint8Array(expected)), null);
  assert.deepEqual(checkProfile(new Uint8Array(expected)), []);
});
