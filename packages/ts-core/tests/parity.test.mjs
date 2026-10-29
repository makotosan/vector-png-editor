// Cross-check: the TS port's verdicts against the running Python
// Core (the repo source, via PYTHONPATH) over a broad case corpus —
// the pinned catalog, the user's corpus SVGs, the normalization
// catalog inputs, the Core tests' own cases, and crafted edge cases
// for both the container and the validator (positions, namespace
// expansion, traversal order, zlib stream exactness, ...).
// The normalization section additionally compares the normalizer's
// output bytes and section 7 reports exactly, and the gated
// verdicts across engines (Cairo vs resvg). Since the gate
// accommodation (option A, below), the gates are expected to
// agree on every case; KNOWN_GATE_DIVERGENCES is empty and any
// disagreement fails this suite.
//
// This is port verification, not renderer-conformance work: no
// pixels are compared. Gated on a Python with the Core's
// dependencies, following the repo's real-Core gating precedent:
// set VECTOR_PNG_TEST_PYTHON (default /tmp/buildenv/bin/python);
// the suite skips when the interpreter is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import {
  assembleVectorPng,
  extractSource,
  inspectDocument,
  parseChunks,
  parseDocument,
  rebuildVectorPng,
} from '../src/container.ts';
import { checkProfile, validateSource } from '../src/validate.ts';
import {
  NormalizeFailure,
  NormalizeRejection,
  normalizeDocument,
  normalizeStructure,
} from '../src/normalize.ts';
import { TsCoreError } from '../src/errors.ts';
import { loadSpikeFonts } from './test-fonts.mjs';
import {
  assemble,
  ihdr,
  itxtPayload,
  rasterPng,
  scanlines,
  withSource,
  KEY,
} from './pngbuild.mjs';

const execFileAsync = promisify(execFile);
const python = process.env.VECTOR_PNG_TEST_PYTHON ?? '/tmp/buildenv/bin/python';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreSrc = join(repoRoot, 'packages/core/src');
const driverPath = fileURLToPath(new URL('parity_driver.py', import.meta.url));
const available = existsSync(python) && existsSync(coreSrc);
const parityTest = available ? test : test.skip;

const enc = (s) => new TextEncoder().encode(s);
const b64 = (data) => Buffer.from(data).toString('base64');
const SVGNS = 'http://www.w3.org/2000/svg';
const SVG =
  `<svg xmlns="${SVGNS}" width="2" height="2"><rect width="1" height="2" fill="red"/></svg>`;

// ----------------------------------------------------------------
// SVG cases
// ----------------------------------------------------------------

async function buildSvgCases() {
  const cases = new Map();
  const add = (id, source) => cases.set(id, source);

  const catalog = JSON.parse(
    await readFile(
      join(repoRoot, 'packages/core/tests/fixtures/vectors.json'),
      'utf8',
    ),
  ).fixtures;
  for (const fixture of catalog) {
    if ('source_base64' in fixture) {
      add(`catalog:${fixture.name}`, Buffer.from(fixture.source_base64, 'base64'));
    }
  }

  const corpusDir = join(dirname(repoRoot), 'user/files');
  if (existsSync(corpusDir)) {
    for (const name of (await readdir(corpusDir)).filter((n) => n.endsWith('.svg')).sort()) {
      add(`corpus:${name}`, await readFile(join(corpusDir, name)));
    }
  }

  const normDir = join(repoRoot, 'packages/core/tests/fixtures/normalization');
  const normCases = JSON.parse(await readFile(join(normDir, 'cases.json'), 'utf8'));
  for (const c of normCases) add(`norm:${c.id}`, enc(c.input));
  add('nameplate:input', await readFile(join(normDir, 'nameplate.input.svg')));
  add('nameplate:expected', await readFile(join(normDir, 'nameplate.expected.svg')));

  // The Core test suites' own cases.
  add('core:decl-encoding', enc('<?xml version="1.0" encoding="ISO-8859-1"?>' + SVG));
  add('core:trailing-pi', enc(SVG + '<?real pi?>'));
  add('core:dtd', enc('<!DOCTYPE svg [<!ENTITY x "boom">]>' + SVG));
  add('core:url-fill', enc(SVG.replace('red', 'url(https://example.com/)')));
  add('core:image', enc(SVG.replace('<rect', '<image')));
  add('core:style-attr', enc(SVG.replace('fill="red"', 'style="fill:red"')));
  add('core:onload', enc(SVG.replace('fill="red"', 'onload="run()"')));
  add('core:use', enc(`<svg xmlns="${SVGNS}"><use href="#x"/></svg>`));
  add('core:bad-utf8', new Uint8Array([0xff]));
  add('core:nul', enc('\x00' + SVG));
  add('core:spaces-over-cap', enc(' '.repeat(1_000_001)));

  const VALID =
    `<svg xmlns="${SVGNS}" width="16" height="16">` +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
    '<stop offset="1" stop-color="#00f"/></linearGradient>' +
    '<clipPath id="c"><rect width="8" height="16"/></clipPath></defs>' +
    '<g clip-path="url(#c)"><rect width="16" height="16" fill="url(#g)"/>' +
    '<text x="1" y="9" font-size="6">A<tspan dx="1">B</tspan></text></g></svg>';
  add('sc:valid', enc(VALID));
  add('sc:image', enc(VALID.replace('<rect width="16"', '<image width="16"')));
  add('sc:class', enc(VALID.replace('<g clip-path', '<g class="hero" clip-path')));
  add('sc:forbidden', enc(VALID.replace('fill="url(#g)"', 'fill="red;behavior:url(x)"')));
  add('sc:structure', enc(`<svg xmlns="${SVGNS}" width="8" height="8"><g><stop offset="0"/></g></svg>`));
  add('sc:ext-url', enc(VALID.replace('fill="url(#g)"', 'fill="url(https://example.com/x.svg#g)"')));
  add('sc:missing-ref', enc(VALID.replace('fill="url(#g)"', 'fill="url(#missing)"')));
  add('sc:script', enc(VALID.replace('</svg>', '<script>alert(1)</script></svg>')));
  add('sc:onclick', enc(VALID.replace('<rect width="8"', '<rect onclick="x()" width="8"')));
  add('sc:wrong-type', enc(VALID.replace('fill="url(#g)"', 'fill="url(#c)"')));
  add('sc:dup-id', enc(`<svg xmlns="${SVGNS}"><g id="a"/><g id="a"/></svg>`));
  add('sc:invalid-id', enc(`<svg xmlns="${SVGNS}"><g id="1bad"/></svg>`));
  add('sc:ref-in-def', enc(
    `<svg xmlns="${SVGNS}"><defs>` +
    '<clipPath id="c"><rect width="4" height="4"/></clipPath>' +
    '<clipPath id="d"><rect width="4" height="4" clip-path="url(#c)"/></clipPath>' +
    '</defs></svg>',
  ));

  // Crafted edge cases.
  const X = {
    'unbound-prefix': `<svg xmlns="${SVGNS}"><foo:bar/></svg>`,
    'dup-expanded': `<svg xmlns="${SVGNS}" xmlns:a="urn:x" xmlns:b="urn:x" a:id="1" b:id="2"/>`,
    'xmlns-empty-decl': `<svg xmlns="${SVGNS}" xmlns:p=""/>`,
    'xmlns-prefix-decl': `<svg xmlns="${SVGNS}" xmlns:xmlns="urn:x"/>`,
    'xml-wrong-uri': `<svg xmlns="${SVGNS}" xmlns:xml="urn:wrong"/>`,
    'xml-right-uri': `<svg xmlns="${SVGNS}" xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="en"/>`,
    'multi-colon': `<svg xmlns="${SVGNS}"><a:b:c/></svg>`,
    'xmlns-elem': `<svg xmlns="${SVGNS}"><xmlns:g/></svg>`,
    'pi-stylesheet': `<?xml-stylesheet href="x"?>${SVG}`,
    'pi-in-content': `<svg xmlns="${SVGNS}"><text><?go now?></text></svg>`,
    'decl-mid': `${SVG}<?xml version="1.0"?>`,
    'doctype-simple': `<!DOCTYPE svg>${SVG}`,
    'charref-zero': `<svg xmlns="${SVGNS}"><text>&#0;</text></svg>`,
    'charref-surrogate': `<svg xmlns="${SVGNS}"><text>&#xD800;</text></svg>`,
    'charref-too-big': `<svg xmlns="${SVGNS}"><text>&#x110000;</text></svg>`,
    'charref-ok': `<svg xmlns="${SVGNS}"><text>&#65;&#x1F600;</text></svg>`,
    'charref-in-url': `<svg xmlns="${SVGNS}"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url&#40;#g)"/></svg>`,
    'entity-undefined': `<svg xmlns="${SVGNS}"><text>&foo;</text></svg>`,
    'entity-amp': `<svg xmlns="${SVGNS}"><text>a &amp; b</text></svg>`,
    'bare-amp': `<svg xmlns="${SVGNS}"><text>a & b</text></svg>`,
    'comment-double-hyphen': `<svg xmlns="${SVGNS}"><!-- a -- b --></svg>`,
    'comment-ok': `<svg xmlns="${SVGNS}"><!-- a > b --><rect width="1" height="1"/></svg>`,
    'cdata-ok': `<svg xmlns="${SVGNS}"><text><![CDATA[<not>markup & raw]]></text></svg>`,
    'cdata-prolog': `<![CDATA[x]]>${SVG}`,
    'text-cdata-close': `<svg xmlns="${SVGNS}"><text>a]]>b</text></svg>`,
    'invalid-char-text': `<svg xmlns="${SVGNS}"><text>a\x0bb</text></svg>`,
    'invalid-char-attr': `<svg xmlns="${SVGNS}"><rect fill="a\x0bb"/></svg>`,
    'attr-ws-normalized': `<svg xmlns="${SVGNS}"><g id="a\tb\nc"/></svg>`,
    'attr-charref-tab': `<svg xmlns="${SVGNS}"><g id="a&#9;b"/></svg>`,
    'mismatched-end': `<svg xmlns="${SVGNS}"><g></rect></svg>`,
    'unclosed': `<svg xmlns="${SVGNS}"><g>`,
    'two-roots': `${SVG}${SVG}`,
    'text-before-root': `hello${SVG}`,
    'empty': ``,
    'whitespace-only': `  \n `,
    'foreign-ns-child': `<svg xmlns="${SVGNS}" xmlns:h="http://www.w3.org/1999/xhtml"><h:p/></svg>`,
    'no-ns-child': `<svg xmlns="${SVGNS}"><g xmlns=""><rect width="1" height="1"/></g></svg>`,
    'prefixed-root': `<s:svg xmlns:s="${SVGNS}"><rect width="1" height="1"/></s:svg>`,
    'dup-attr-raw': `<svg xmlns="${SVGNS}"><rect width="1" width="2"/></svg>`,
    'valid-misc': `\ufeff<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- c --><svg xmlns='${SVGNS}' width='2' height='2'><text>A&#66;<![CDATA[x]]></text><rect width="1" height="1" /></svg>`,
    'url-uppercase': `<svg xmlns="${SVGNS}"><rect fill="URL(#g)"/></svg>`,
    'url-spaces': `<svg xmlns="${SVGNS}"><rect fill="url( #g )"/></svg>`,
    'style-element': `<svg xmlns="${SVGNS}"><style>.a {fill: red}</style></svg>`,
    'empty-id': `<svg xmlns="${SVGNS}"><g id=""/></svg>`,
    'self-ref-clip': `<svg xmlns="${SVGNS}"><defs><clipPath id="c"><rect clip-path="url(#c)"/></clipPath></defs></svg>`,
    'stop-color-url': `<svg xmlns="${SVGNS}"><defs><linearGradient id="a"><stop offset="0" stop-color="url(#a)"/></linearGradient></defs></svg>`,
    'order-two-violations': `<svg xmlns="${SVGNS}"><g foo="1"/><image/></svg>`,
    'order-two-violations-rev': `<svg xmlns="${SVGNS}"><image/><g foo="1"/></svg>`,
    'decl-version-name': `<?xml version="abc"?>${SVG}`,
    'decl-version-11': `<?xml version="1.1"?>${SVG}`,
    'decl-version-trailing-space': `<?xml version="1.0" ?>${SVG}`,
    'decl-version-space-in-value': `<?xml version="1.0 "?>${SVG}`,
    'decl-encoding-empty': `<?xml version="1.0" encoding=""?>${SVG}`,
    'decl-encoding-nodash': `<?xml version="1.0" encoding="utf8"?>${SVG}`,
    'decl-wrong-order': `<?xml version="1.0" standalone="yes" encoding="UTF-8"?>${SVG}`,
    'decl-uppercase': `<?XML version="1.0"?>${SVG}`,
    'crlf-bad-element': `<svg xmlns="${SVGNS}">\r\n<text>é</text>\r<image/></svg>`,
    'astral-attr-limit-ok': `<svg xmlns="${SVGNS}"><g fill="${'\u{1F600}'.repeat(100_000)}"/></svg>`,
    'astral-attr-limit-over': `<svg xmlns="${SVGNS}"><g fill="${'\u{1F600}'.repeat(100_001)}"/></svg>`,
    'attr-limit-ok': `<svg xmlns="${SVGNS}"><g fill="${'a'.repeat(100_000)}"/></svg>`,
    'attr-limit-over': `<svg xmlns="${SVGNS}"><g fill="${'a'.repeat(100_001)}"/></svg>`,
    'deep-32': `<svg xmlns="${SVGNS}">${'<g>'.repeat(32)}${'</g>'.repeat(32)}</svg>`,
    'deep-33': `<svg xmlns="${SVGNS}">${'<g>'.repeat(33)}${'</g>'.repeat(33)}</svg>`,
    'elements-5000': `<svg xmlns="${SVGNS}">${'<g/>'.repeat(4999)}</svg>`,
    'elements-5001': `<svg xmlns="${SVGNS}">${'<g/>'.repeat(5000)}</svg>`,
    'xlink-attr': `<svg xmlns="${SVGNS}" xmlns:xlink="http://www.w3.org/1999/xlink"><rect xlink:href="#a"/></svg>`,
    'href-attr': `<svg xmlns="${SVGNS}"><rect href="#a"/></svg>`,
    'nested-tspan': `<svg xmlns="${SVGNS}"><text x="1" y="2">A<tspan dx="1">B<tspan dy="2">C</tspan></tspan></text></svg>`,
    'gradient-chain': `<svg xmlns="${SVGNS}"><defs><linearGradient id="a"><stop offset="0" stop-color="red"/></linearGradient><radialGradient id="b"><stop offset="0" stop-color="blue"/></radialGradient></defs><rect fill="url(#a)" stroke="url(#b)" width="1" height="1"/></svg>`,
    'entity-in-attr': `<svg xmlns="${SVGNS}"><g id="a&amp;b"/></svg>`,
    'comment-with-entity-text': `<svg xmlns="${SVGNS}"><!-- &foo; <?pi?> --><rect width="1" height="1"/></svg>`,
  };
  for (const [id, source] of Object.entries(X)) add(`x:${id}`, enc(source));
  add('x:bom-only', new Uint8Array([0xef, 0xbb, 0xbf]));
  return cases;
}

// ----------------------------------------------------------------
// PNG cases
// ----------------------------------------------------------------

async function buildPngCases() {
  const cases = new Map(); // id -> { data, messageFree?: string[] }
  const add = (id, data, messageFree = []) => cases.set(id, { data, messageFree });

  const catalog = JSON.parse(
    await readFile(
      join(repoRoot, 'packages/core/tests/fixtures/vectors.json'),
      'utf8',
    ),
  ).fixtures;
  for (const fixture of catalog) {
    add(`catalog:${fixture.name}`, Buffer.from(fixture.png_base64, 'base64'));
  }

  const base = () => rasterPng({ width: 2, height: 2, color: 6, depth: 8 });
  const withSvg = (raster) => withSource(raster, enc(SVG));
  const idatOf = (w, h, d, c, i = 0) => deflateSync(scanlines(w, h, d, c, i));

  add('built:plain', base());
  add('built:with-source', withSvg(base()));
  add('built:trailing', Buffer.concat([withSvg(base()), Buffer.from([0])]));
  add('built:not-png', Buffer.from('this is not a png file'));
  const crcBad = Buffer.from(withSvg(base()));
  crcBad[crcBad.length - 5] ^= 0xff;
  add('built:bad-crc', crcBad);
  add('built:dup-source', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)], ['iTXt', itxtPayload(enc(SVG))],
    ['iTXt', itxtPayload(enc(SVG))], ['IDAT', idatOf(2, 2, 8, 6)],
    ['IEND', Buffer.alloc(0)],
  ]));
  add('built:source-after-idat', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)], ['IDAT', idatOf(2, 2, 8, 6)],
    ['iTXt', itxtPayload(enc(SVG))], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:unknown-ancillary', withSvg(rasterPng({ extraBefore: [['abCD', Buffer.from('opaque')]] })));
  add('built:unknown-critical', rasterPng({ extraBefore: [['ABCD', Buffer.from('opaque')]] }));
  add('built:apng', withSvg(rasterPng({ extraBefore: [['acTL', Buffer.alloc(8)]] })));
  add('built:bad-filter', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)],
    ['IDAT', deflateSync(Buffer.from([5, ...scanlines(2, 2, 8, 6, 0).subarray(1)]))],
    ['IEND', Buffer.alloc(0)],
  ]));
  const idatCorrupt = Buffer.from(idatOf(2, 2, 8, 6));
  idatCorrupt[4] ^= 0xff;
  add('built:idat-data-corrupt', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)], ['IDAT', idatCorrupt], ['IEND', Buffer.alloc(0)],
  ]), ['read', 'inspect', 'extract']);
  add('built:idat-extra-stream', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)],
    ['IDAT', Buffer.concat([idatOf(2, 2, 8, 6), deflateSync(enc('extra'))])],
    ['IEND', Buffer.alloc(0)],
  ]), ['read', 'inspect']);
  add('built:idat-truncated', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)],
    ['IDAT', idatOf(2, 2, 8, 6).subarray(0, 4)],
    ['IEND', Buffer.alloc(0)],
  ]), ['read', 'inspect']);
  add('built:nonconsecutive-idat', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)],
    ['IDAT', idatOf(2, 2, 8, 6).subarray(0, 2)],
    ['tEXt', Buffer.from('note\0inert')],
    ['IDAT', idatOf(2, 2, 8, 6).subarray(2)],
    ['IEND', Buffer.alloc(0)],
  ]));
  add('built:plte-late', assemble([
    ['IHDR', ihdr(2, 2, 8, 3)], ['IDAT', idatOf(2, 2, 8, 3)],
    ['PLTE', Buffer.from([0, 0, 0])], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:plte-missing', rasterPng({ color: 3, depth: 8 }));
  add('built:hist-wrong-length', assemble([
    ['IHDR', ihdr(2, 2, 8, 3)], ['PLTE', Buffer.from([0, 0, 0, 9, 9, 9])],
    ['hIST', Buffer.alloc(2)], ['IDAT', idatOf(2, 2, 8, 3)], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:trns-gray-wrong-length', assemble([
    ['IHDR', ihdr(2, 2, 8, 0)], ['tRNS', Buffer.alloc(3)],
    ['IDAT', idatOf(2, 2, 8, 0)], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:dup-gama', rasterPng({
    extraBefore: [['gAMA', Buffer.alloc(4)], ['gAMA', Buffer.alloc(4)]],
  }));
  add('built:late-exif', rasterPng({ extraAfter: [['eXIf', Buffer.from('Exif')]] }));
  add('built:source-language-nonascii', withSource(base(), enc(SVG), { language: 'e\x80' }),
    ['read', 'inspect', 'extract']);
  add('built:source-translated-invalid', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)],
    ['iTXt', Buffer.concat([
      Buffer.from(KEY), Buffer.from([0, 1, 0]), Buffer.from([0]),
      Buffer.from([0xff, 0xfe]), Buffer.from([0]), deflateSync(enc(SVG)),
    ])],
    ['IDAT', idatOf(2, 2, 8, 6)], ['IEND', Buffer.alloc(0)],
  ]), ['read', 'inspect', 'extract']);
  add('built:source-language-lenient', withSource(base(), enc(SVG), { language: 'en--US' }));
  add('built:source-uncompressed', withSource(base(), enc(SVG), { flag: 0, compressed: enc(SVG) }));
  const sourceCorrupt = Buffer.from(deflateSync(enc(SVG)));
  sourceCorrupt[6] ^= 0xff;
  add('built:source-zlib-corrupt', withSource(base(), enc(SVG), { compressed: sourceCorrupt }),
    ['read', 'inspect', 'extract']);
  add('built:source-keyword-only', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)], ['iTXt', Buffer.from(KEY)],
    ['IDAT', idatOf(2, 2, 8, 6)], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:palette-oor', assemble([
    ['IHDR', ihdr(2, 2, 8, 3)], ['PLTE', Buffer.from([255, 0, 0])],
    ['IDAT', deflateSync(Buffer.from([0, 5, 5, 0, 5, 5]))], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:adam7', assemble([
    ['IHDR', ihdr(8, 8, 8, 6, 1)], ['iTXt', itxtPayload(enc(SVG))],
    ['IDAT', idatOf(8, 8, 8, 6, 1)], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:gray16', rasterPng({ width: 3, height: 2, color: 0, depth: 16 }));
  add('built:gray1-interlaced', rasterPng({ width: 9, height: 9, color: 0, depth: 1, interlace: 1 }));
  add('built:rgb16-interlaced', rasterPng({ width: 5, height: 4, color: 2, depth: 16, interlace: 1 }));
  add('built:palette2', rasterPng({
    width: 3, height: 2, color: 3, depth: 2, palette: Buffer.alloc(12),
  }));
  add('built:oversize-side', assemble([
    ['IHDR', ihdr(4097, 1, 8, 6)], ['IDAT', deflateSync(Buffer.alloc(8))],
    ['IEND', Buffer.alloc(0)],
  ]));
  add('built:chunk-overrun', (() => {
    const data = Buffer.from(withSvg(base()));
    data.writeUInt32BE(0x00ffffff, 8);
    return data;
  })());
  add('built:bad-chunk-name', assemble([
    ['IHDR', ihdr(2, 2, 8, 6)], ['bad!', Buffer.alloc(0)],
    ['IDAT', idatOf(2, 2, 8, 6)], ['IEND', Buffer.alloc(0)],
  ]));
  add('built:source-script', withSource(base(),
    enc(`<svg xmlns="${SVGNS}"><script>inert</script></svg>`)));
  add('built:source-dtd', withSource(base(),
    enc('<!DOCTYPE svg [<!ENTITY x "boom">]>' + SVG)));
  add('built:source-unsafe-url', withSource(base(),
    enc(SVG.replace('red', 'url(https://example.com/)'))));
  return cases;
}

// ----------------------------------------------------------------
// Outcome computation and comparison
// ----------------------------------------------------------------

function tsOutcome(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof TsCoreError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

function assertOutcomeEqual(ts, py, label, compareMessage = true) {
  assert.equal(py.fatal, undefined, `${label}: Python raised unexpectedly: ${py.fatal}`);
  assert.equal(ts.ok, py.ok, `${label}: ok differs (ts=${JSON.stringify(ts)} py=${JSON.stringify(py)})`);
  if (py.ok) {
    assert.deepEqual(ts.value, py.value, `${label}: values differ`);
  } else {
    assert.equal(ts.code, py.code, `${label}: error codes differ (ts=${ts.code} py=${py.code})`);
    if (compareMessage) {
      assert.equal(ts.message, py.message, `${label}: error messages differ`);
    }
  }
}

async function runDriver(manifest) {
  const env = {
    ...process.env,
    PYTHONPATH: coreSrc + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ''),
  };
  // Manifest/results travel as files: this sandbox proxies stdio
  // over sockets that stall on multi-megabyte payloads.
  const dir = await mkdtemp(join(tmpdir(), 'ts-core-parity-'));
  const manifestPath = join(dir, 'manifest.json');
  const resultsPath = join(dir, 'results.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    await execFileAsync(python, [driverPath, manifestPath, resultsPath], {
      maxBuffer: 16 * 1024 * 1024,
      env,
      timeout: 600_000,
    });
    return JSON.parse(await readFile(resultsPath, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

parityTest('TS and Python agree on every SVG case (validate + diagnostics)', async () => {
  const cases = await buildSvgCases();
  const manifest = {
    svg: [...cases].map(([id, source]) => ({ id, source_base64: b64(source) })),
    png: [],
    build: null,
  };
  const results = await runDriver(manifest);
  let checked = 0;
  for (const [id, source] of cases) {
    const py = results.svg[id];
    assert.ok(py, `driver returned no result for ${id}`);
    assertOutcomeEqual(tsOutcome(() => validateSource(source)), py.validate, `${id} validate`);
    assertOutcomeEqual(tsOutcome(() => checkProfile(source)), py.profile, `${id} profile`);
    assertOutcomeEqual(
      tsOutcome(() => checkProfile(source, { strictStructure: true })),
      py.profile_strict,
      `${id} profile_strict`,
    );
    checked += 1;
  }
  assert.ok(checked >= 100, `expected a broad corpus, got ${checked}`);
});

parityTest('TS and Python agree on every PNG case (read + inspect + extract)', async () => {
  const cases = await buildPngCases();
  const manifest = {
    svg: [],
    png: [...cases].map(([id, { data }]) => ({ id, png_base64: b64(data) })),
    build: null,
  };
  const results = await runDriver(manifest);
  for (const [id, { data, messageFree }] of cases) {
    const py = results.png[id];
    assert.ok(py, `driver returned no result for ${id}`);
    const free = (section) => !messageFree.includes(section);
    assertOutcomeEqual(
      tsOutcome(() => {
        const doc = parseDocument(data);
        return {
          source_base64: doc.source !== null ? b64(doc.source) : null,
          width: doc.width,
          height: doc.height,
          color_type: doc.color_type,
          bit_depth: doc.bit_depth,
          interlace: doc.interlace,
          png_sha256: doc.png_sha256,
        };
      }),
      py.read,
      `${id} read`,
      free('read'),
    );
    assertOutcomeEqual(tsOutcome(() => inspectDocument(data)), py.inspect, `${id} inspect`, free('inspect'));
    assertOutcomeEqual(
      tsOutcome(() => ({ svg_base64: b64(extractSource(data)) })),
      py.extract,
      `${id} extract`,
      free('extract'),
    );
  }
});

parityTest('a Python-built vector-png parses identically and rebuilds byte-exactly', async () => {
  const buildSource = enc(
    `<svg xmlns="${SVGNS}" width="16" height="16">` +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
    '<stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
    '<rect width="16" height="16" fill="url(#g)"/></svg>',
  );
  const first = await runDriver({
    svg: [],
    png: [],
    build: { source_base64: b64(buildSource), width: 16, height: 16 },
  });
  assert.ok(first.build && !first.build.error, `Python build failed: ${first.build?.error}`);
  const built = Buffer.from(first.build.png_base64, 'base64');
  const second = await runDriver({
    svg: [],
    png: [{ id: 'python-built', png_base64: b64(built) }],
    build: null,
  });
  const py = second.png['python-built'];
  assertOutcomeEqual(
    tsOutcome(() => {
      const doc = parseDocument(built);
      return {
        source_base64: doc.source !== null ? b64(doc.source) : null,
        width: doc.width,
        height: doc.height,
        color_type: doc.color_type,
        bit_depth: doc.bit_depth,
        interlace: doc.interlace,
        png_sha256: doc.png_sha256,
      };
    }),
    py.read,
    'python-built read',
  );
  assertOutcomeEqual(tsOutcome(() => inspectDocument(built)), py.inspect, 'python-built inspect');
  // The TS rebuild reproduces the Python build byte-for-byte.
  assert.deepEqual(rebuildVectorPng(built), built);
  // The TS assembly of the same raster + source may differ only in
  // the iTXt payload (platform zlib representation); the document
  // it produces is the same and its source round-trips byte-exactly.
  const rasterOnly = assemble(
    parseChunks(built)
      .filter((c) => ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(c.kind))
      .map((c) => [c.kind, Buffer.from(c.payload)]),
  );
  const assembled = assembleVectorPng(rasterOnly, buildSource);
  assert.deepEqual(
    parseChunks(assembled).map((c) => c.kind),
    parseChunks(built).map((c) => c.kind),
  );
  assert.deepEqual(Buffer.from(parseDocument(assembled).source), Buffer.from(buildSource));
  assert.equal(inspectDocument(assembled).kind, 'vector-png');
});

// ----------------------------------------------------------------
// Normalization cases (structure + gated entry point)
// ----------------------------------------------------------------

async function buildNormalizeCases() {
  const cases = new Map();
  const add = (id, source) => cases.set(id, source);

  const normDir = join(repoRoot, 'packages/core/tests/fixtures/normalization');
  const normCases = JSON.parse(await readFile(join(normDir, 'cases.json'), 'utf8'));
  for (const c of normCases) add(`norm:${c.id}`, enc(c.input));
  add('nameplate:input', await readFile(join(normDir, 'nameplate.input.svg')));
  add('nameplate:expected', await readFile(join(normDir, 'nameplate.expected.svg')));

  const corpusDir = join(dirname(repoRoot), 'user/files');
  if (existsSync(corpusDir)) {
    for (const name of (await readdir(corpusDir)).filter((n) => n.endsWith('.svg')).sort()) {
      add(`corpus:${name}`, await readFile(join(corpusDir, name)));
    }
  }

  // Crafted edge cases: ElementTree serialization details (comment
  // merging, character references, BOM + declaration), the namespace
  // failure wordings expat produces, marker clone tails, and the
  // Issue #59 stroke="none" decision case.
  const X = {
    'stroke-none-marker':
      '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
      '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">' +
      '<path d="M0,0 L12,6 L0,12 Z" fill="black"/></marker></defs>' +
      '<path d="M5 20 H50" fill="none" stroke="none" marker-end="url(#a)"/></svg>',
    'g-format':
      '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
      '<marker id="a" markerWidth="7.5" markerHeight="3.25" refX="0" refY="0" orient="auto">' +
      '<path d="M0,0 L7.5,1.625 L0,3.25 Z" fill="red"/></marker></defs>' +
      '<path d="M1.5 2.25 L30.75 9.125" fill="none" stroke="black" stroke-width="0.5" marker-end="url(#a)"/></svg>',
    'cdata-comment':
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<desc>ab<!-- x -->cd</desc><style><![CDATA[.a{fill:red}]]></style>' +
      '<rect class="a" width="5" height="5"/></svg>',
    'text-entities':
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<desc>a &amp; b &lt;c&gt; &#65;&#x42;</desc><rect width="5" height="5"/></svg>',
    'bom-decl':
      '\ufeff<?xml version="1.0" encoding="UTF-8"?>' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>',
    'deep-clone-tail':
      '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><defs>' +
      '<marker id="a" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">' +
      '<path d="M0,0 L12,6 L0,12 Z" fill="black"/> </marker></defs>' +
      '<path d="M5 20 H50" fill="none" marker-end="url(#a)"/></svg>',
    'nested-svg': '<svg xmlns="http://www.w3.org/2000/svg"><svg width="5"/></svg>',
    'unbound-prefix': '<svg xmlns="http://www.w3.org/2000/svg"><p:path d="M0 0"/></svg>',
    'dup-expanded':
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="urn:x" xmlns:q="urn:x" p:a="1" q:a="2"/>',
    'empty-prefix': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p=""><rect width="1"/></svg>',
    // Reference-shaped TEXT content is not a reference: the gate
    // must still render it (the section 2 inspection, not a raw
    // scan, is what refuses real external references).
    'text-url-mention':
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30">' +
      '<style>.a {fill: black}</style><text class="a" x="2" y="20">url(http://example.com)</text></svg>',
  };
  for (const [id, source] of Object.entries(X)) add(`extra:${id}`, enc(source));
  return cases;
}

// Gate divergences between the engines were renderer semantics,
// not port bugs, in three classes — in each, the structure
// outputs are byte-identical (asserted by the structure test)
// and the Python gate passed on CairoSVG while the TS gate
// reported render-mismatch on resvg:
// - css-rx: resvg ignores the SVG2 geometry properties in CSS
//   (measured: the whole set — x, y, width, height, cx, cy, r,
//   rx, ry); materializing them as attributes (what the
//   transformation does) changed the resvg render.
// - marker-raster: resvg rasterized a native marker and the
//   spec's expanded <g> clone with slightly different
//   antialiasing (edge deltas up to ~46/255 on the iso7010
//   arrowheads).
// - stroke-none: resvg does not paint native markers on
//   stroke="none" hosts (CairoSVG paints them); the expanded
//   clone IS painted, so the within-resvg gate saw a difference.
// The user approved option A (2026-10-29): the TS gate renders
// its BEFORE image from an accommodated copy of the input —
// geometry winners from CSS also set as attributes, markers
// expanded by the transformation's own section 3.1 code path
// (see gateInputText in src/normalize.ts) — so both engines'
// gates now agree on every case and this table is EMPTY. It is
// kept as the enforcement mechanism: if a future case ever
// diverges, the gated comparison below fails and the case must
// be isolated and reported precisely — never re-tagged here
// silently.
const KNOWN_GATE_DIVERGENCES = {};

/** Split a section 7 report into the part that must be identical
 * across engines and the render block, whose engine-specific fields
 * (renderer, renderer_version, color_alpha, text_policy) are
 * reported, not equated; the shared fields and viewport must agree. */
function splitReport(report) {
  if (report === null || typeof report.render !== 'object' || report.render === null) {
    return { rest: report, render: null };
  }
  const { render, ...rest } = report;
  const { renderer, renderer_version, color_alpha, text_policy, ...shared } = render;
  return {
    rest,
    render: { shared, engine: { renderer, renderer_version, color_alpha, text_policy } },
  };
}

let normalizeResultsPromise;
async function runNormalizeDriver(cases) {
  // Both normalize tests consume the same driver run (the Python
  // gate renders every case; once per suite is enough).
  normalizeResultsPromise ??= runDriver({
    svg: [],
    png: [],
    build: null,
    normalize: [...cases].map(([id, source]) => ({ id, source_base64: b64(source) })),
  }).then((results) => results.normalize);
  return normalizeResultsPromise;
}

parityTest('TS and Python agree on normalization structure (verdict, code, bytes, report)', async () => {
  const cases = await buildNormalizeCases();
  const py = await runNormalizeDriver(cases);
  let checked = 0;
  for (const [id, source] of cases) {
    const expected = py[id]?.structure;
    assert.ok(expected, `driver returned no structure result for ${id}`);
    assert.equal(expected.fatal, undefined, `${id}: Python raised unexpectedly: ${expected.fatal}`);
    let actual;
    try {
      const { output, report } = normalizeStructure(source);
      actual = { ok: true, output_base64: b64(output), report };
    } catch (error) {
      assert.ok(error instanceof NormalizeFailure, `${id}: unexpected error ${error}`);
      actual = { ok: false, code: error.code, stage: error.stage, message: error.message };
    }
    assert.equal(actual.ok, expected.ok, `${id}: verdict differs`);
    if (expected.ok) {
      assert.equal(actual.output_base64, expected.value.output_base64, `${id}: output bytes differ`);
      assert.deepEqual(actual.report, expected.value.report, `${id}: reports differ`);
    } else {
      assert.equal(actual.code, expected.code, `${id}: codes differ`);
      assert.equal(actual.stage, expected.stage, `${id}: stages differ`);
      assert.equal(actual.message, expected.message, `${id}: messages differ`);
    }
    checked += 1;
  }
  assert.ok(checked >= 40, `expected the full normalize corpus, got ${checked}`);
});

parityTest('TS and Python gates agree on every case (structure and gate verdict)', async () => {
  const cases = await buildNormalizeCases();
  const py = await runNormalizeDriver(cases);
  const fonts = await loadSpikeFonts();
  for (const [id, source] of cases) {
    const expected = py[id]?.gated;
    assert.ok(expected, `driver returned no gated result for ${id}`);
    assert.equal(expected.fatal, undefined, `${id}: Python raised unexpectedly: ${expected.fatal}`);
    let actual;
    try {
      const { output, report } = await normalizeDocument(source, { fonts });
      actual = { ok: true, output_base64: b64(output), report };
    } catch (error) {
      assert.ok(error instanceof NormalizeRejection, `${id}: unexpected error ${error}`);
      actual = { ok: false, code: error.code, message: error.message, report: error.report };
    }
    if (id in KNOWN_GATE_DIVERGENCES) {
      // Python passes; the TS gate reports the render difference
      // its engine actually produces. Nothing else may diverge.
      assert.equal(expected.ok, true, `${id}: tagged divergence expects a Python pass`);
      assert.equal(actual.ok, false, `${id}: tagged divergence expects a TS gate failure`);
      assert.equal(actual.code, 'render-mismatch', `${id}: divergence code`);
      assert.equal(actual.report.checks.render, 'mismatch', `${id}: divergence check`);
      continue;
    }
    assert.equal(actual.ok, expected.ok, `${id}: gate verdicts differ (ts=${actual.ok ? 'ok' : actual.code} py=${expected.ok ? 'ok' : expected.code})`);
    if (expected.ok) {
      assert.equal(actual.output_base64, expected.output_base64, `${id}: gated output bytes differ`);
    } else {
      assert.equal(actual.code, expected.code, `${id}: gate failure codes differ`);
      if (actual.code !== 'render-error' && actual.code !== 'render-mismatch') {
        assert.equal(actual.message, expected.message, `${id}: gate failure messages differ`);
      }
    }
    const tsSplit = splitReport(actual.report);
    const pySplit = splitReport(expected.report);
    assert.deepEqual(tsSplit.rest, pySplit.rest, `${id}: gated reports differ outside the render block`);
    assert.deepEqual(tsSplit.render?.shared, pySplit.render?.shared, `${id}: gated render blocks differ outside the engine fields`);
  }
});
