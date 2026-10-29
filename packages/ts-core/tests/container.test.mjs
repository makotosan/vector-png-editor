// PNG container tests for the TS port. The pinned catalog comes
// from the vendored fixtures (packages/ts-core/fixtures/
// vectors.json, relocated from the retired Python Core's test
// suite); structural cases are transcribed from the Core's
// test_core.py / test_container_audit.py recipes; the baked
// expectations below are the standing coverage (the former live
// cross-check against the running Python Core was removed with
// the Core's retirement - see the ts-core README).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  assembleVectorPng,
  extractSource,
  inspectDocument,
  parseChunks,
  parseDocument,
  rebuildVectorPng,
} from '../src/container.ts';
import { TsCoreError } from '../src/errors.ts';
import {
  assemble,
  chunk,
  ihdr,
  itxtPayload,
  rasterPng,
  scanlines,
  withSource,
  KEY,
  SIGNATURE,
} from './pngbuild.mjs';

const enc = (s) => new TextEncoder().encode(s);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="2" fill="red"/></svg>';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function code(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    assert.ok(error instanceof TsCoreError, `expected TsCoreError, got ${error}`);
    return error.code;
  }
}
const parseCode = (data) => code(() => parseDocument(data));

// --- The pinned container catalog (vectors.json) ---

const catalogPath = fileURLToPath(
  new URL('../fixtures/vectors.json', import.meta.url),
);
const catalog = JSON.parse(await readFile(catalogPath, 'utf8')).fixtures;

// Expected rejection codes, per the Core's semantics; the catalog
// itself records only container_valid, so these are the port's
// transcription (verified against the Python Core by parity tests).
const CATALOG_REJECTS = {
  'duplicate-source': 'invalid-container',
  'wrong-chunk-type': 'invalid-container',
  uncompressed: 'invalid-container',
  'wrong-method': 'invalid-container',
  'trailing-zlib': 'invalid-container',
  'invalid-utf8': 'invalid-svg',
  'wrong-root': 'invalid-svg',
  dtd: 'invalid-svg',
  'processing-instruction': 'invalid-svg',
  'wrong-xml-encoding': 'invalid-svg',
  'apng-marker': 'invalid-container',
  'trailing-file-data': 'invalid-container',
  'bad-crc': 'invalid-container',
};

for (const fixture of catalog) {
  test(`catalog: ${fixture.name}`, () => {
    const data = Buffer.from(fixture.png_base64, 'base64');
    if (fixture.name === 'missing-source') {
      const doc = parseDocument(data);
      assert.equal(doc.source, null);
      assert.equal(inspectDocument(data).kind, 'png');
      return;
    }
    if (fixture.container_valid) {
      const doc = parseDocument(data);
      const expectedSource = Buffer.from(fixture.source_base64, 'base64');
      assert.deepEqual(Buffer.from(doc.source), expectedSource);
      const report = inspectDocument(data);
      assert.equal(report.kind, 'vector-png');
      assert.equal(report.wire, 'v1');
      assert.equal(report.preview, 'not-checked');
      assert.equal(report.svg_sha256, sha256(expectedSource));
      assert.equal(report.png_sha256, sha256(data));
      assert.deepEqual(Buffer.from(extractSource(data)), expectedSource);
    } else {
      assert.equal(parseCode(data), CATALOG_REJECTS[fixture.name], fixture.reason);
    }
  });
}

test('catalog: rebuild reproduces Core-built files byte-for-byte', () => {
  let checked = 0;
  for (const fixture of catalog) {
    if (!fixture.container_valid) continue;
    const data = Buffer.from(fixture.png_base64, 'base64');
    const kinds = parseChunks(data).map((c) => c.kind);
    const coreLayout =
      kinds.every((k) => ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'iTXt'].includes(k)) &&
      kinds[1] === 'iTXt';
    const rebuilt = rebuildVectorPng(data);
    if (coreLayout) {
      assert.deepEqual(rebuilt, data, fixture.name);
      checked += 1;
    } else {
      // Other valid layouts are normalized to the build layout and
      // still parse to the same document.
      const doc = parseDocument(rebuilt);
      assert.deepEqual(Buffer.from(doc.source), Buffer.from(fixture.source_base64, 'base64'));
    }
  }
  assert.ok(checked >= 5, `expected several Core-layout fixtures, got ${checked}`);
});

// --- Structural acceptance/rejection (Core test recipes) ---

const base = () => rasterPng({ width: 2, height: 2, color: 6, depth: 8 });
const baseWithSource = () => withSource(base(), enc(SVG));

test('a plain PNG inspects as kind png and refuses extraction', () => {
  const data = base();
  const report = inspectDocument(data);
  assert.equal(report.kind, 'png');
  assert.equal(report.wire, null);
  assert.equal(report.svg_bytes, 0);
  assert.equal(report.svg_sha256, null);
  assert.equal(code(() => extractSource(data)), 'ordinary-png');
});

test('a vector-png round-trips: parse, inspect, extract byte-exact', () => {
  const data = baseWithSource();
  const doc = parseDocument(data);
  assert.deepEqual(Buffer.from(doc.source), Buffer.from(enc(SVG)));
  assert.equal(doc.width, 2);
  assert.equal(doc.height, 2);
  assert.equal(doc.color_type, 6);
  assert.equal(doc.bit_depth, 8);
  assert.deepEqual(Buffer.from(extractSource(data)), Buffer.from(enc(SVG)));
});

test('extraction preserves exotic but well-formed sources byte-exactly', () => {
  // BOM + CRLF + an inert comment containing PI-shaped text, as in
  // the Core's test_source_preservation.
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    enc(SVG.replace('><', '>\r\n<').replace('<rect', '<!-- <?inert?> -->\r\n<rect')),
  ]);
  const doc = parseDocument(withSource(base(), source));
  assert.deepEqual(Buffer.from(doc.source), source);
});

test('a profile-unsafe source is still passively extractable', () => {
  const source = enc('<svg xmlns="http://www.w3.org/2000/svg"><script>inert</script></svg>');
  const data = withSource(base(), source);
  assert.deepEqual(Buffer.from(extractSource(data)), Buffer.from(source));
  assert.equal(inspectDocument(data).kind, 'vector-png');
});

const REJECTS = [
  ['trailing bytes after IEND', () => Buffer.concat([baseWithSource(), Buffer.from([0])]), 'invalid-container'],
  ['missing IEND', () => assemble([['IHDR', ihdr(2, 2, 8, 6)], ['IDAT', deflateSync(scanlines(2, 2, 8, 6, 0))]]), 'invalid-container'],
  ['not a PNG', () => Buffer.from('this is not a png file'), 'invalid-container'],
  ['CRC corruption', () => { const d = Buffer.from(baseWithSource()); d[d.length - 5] ^= 0xff; return d; }, 'invalid-container'],
  ['duplicate IHDR', () => {
    const parts = parseChunks(base()).map((c) => [c.kind, c.payload]);
    parts.splice(1, 0, parts[0]);
    return assemble(parts);
  }, 'invalid-container'],
  ['APNG marker', () => withSource(rasterPng({ extraBefore: [['acTL', Buffer.alloc(8)]] }), enc(SVG)), 'invalid-container'],
  ['unknown critical chunk', () => rasterPng({ extraBefore: [['ABCD', Buffer.from('opaque')]] }), 'invalid-container'],
  ['duplicate source iTXt', () => {
    const payload = itxtPayload(enc(SVG));
    return assemble([
      ['IHDR', ihdr(2, 2, 8, 6)], ['iTXt', payload], ['iTXt', payload],
      ['IDAT', deflateSync(scanlines(2, 2, 8, 6, 0))], ['IEND', Buffer.alloc(0)],
    ]);
  }, 'invalid-container'],
  ['keyword in tEXt', () => assemble([
    ['IHDR', ihdr(2, 2, 8, 6)],
    ['tEXt', Buffer.concat([Buffer.from(KEY), Buffer.from([0]), enc(SVG)])],
    ['IDAT', deflateSync(scanlines(2, 2, 8, 6, 0))], ['IEND', Buffer.alloc(0)],
  ]), 'invalid-container'],
  ['uncompressed iTXt', () => withSource(base(), enc(SVG), { flag: 0, compressed: enc(SVG) }), 'invalid-container'],
  ['wrong iTXt method', () => withSource(base(), enc(SVG), { method: 1 }), 'invalid-container'],
  ['trailing bytes after the source zlib stream', () => withSource(base(), enc(SVG), {
    compressed: Buffer.concat([deflateSync(enc(SVG)), Buffer.from('garbage')]),
  }), 'invalid-container'],
  ['concatenated source zlib streams', () => withSource(base(), enc(SVG), {
    compressed: Buffer.concat([deflateSync(enc(SVG)), deflateSync(enc('x'))]),
  }), 'invalid-container'],
  ['non-ASCII language tag', () => withSource(base(), enc(SVG), { language: 'e\x80' }), 'invalid-container'],
  ['invalid UTF-8 translated keyword', () => {
    const payload = Buffer.concat([
      Buffer.from(KEY), Buffer.from([0, 1, 0]), Buffer.from([0]),
      Buffer.from([0xff, 0xfe]), Buffer.from([0]), deflateSync(enc(SVG)),
    ]);
    return assemble([
      ['IHDR', ihdr(2, 2, 8, 6)], ['iTXt', payload],
      ['IDAT', deflateSync(scanlines(2, 2, 8, 6, 0))], ['IEND', Buffer.alloc(0)],
    ]);
  }, 'invalid-container'],
  ['bad PNG filter type', () => {
    const raw = Buffer.from(scanlines(2, 2, 8, 6, 0));
    raw[0] = 5;
    return assemble([
      ['IHDR', ihdr(2, 2, 8, 6)], ['IDAT', deflateSync(raw)], ['IEND', Buffer.alloc(0)],
    ]);
  }, 'invalid-container'],
  ['extra zlib stream inside IDAT', () => assemble([
    ['IHDR', ihdr(2, 2, 8, 6)],
    ['IDAT', Buffer.concat([deflateSync(scanlines(2, 2, 8, 6, 0)), deflateSync(enc('extra'))])],
    ['IEND', Buffer.alloc(0)],
  ]), 'invalid-container'],
  ['nonconsecutive IDAT', () => {
    const body = deflateSync(scanlines(2, 2, 8, 6, 0));
    return assemble([
      ['IHDR', ihdr(2, 2, 8, 6)],
      ['IDAT', body.subarray(0, 2)], ['tEXt', Buffer.from('note\0inert')],
      ['IDAT', body.subarray(2)], ['IEND', Buffer.alloc(0)],
    ]);
  }, 'invalid-container'],
  ['missing IDAT', () => assemble([
    ['IHDR', ihdr(2, 2, 8, 6)], ['IEND', Buffer.alloc(0)],
  ]), 'invalid-container'],
  ['zero dimension', () => assemble([
    ['IHDR', ihdr(0, 2, 8, 6)], ['IDAT', deflateSync(Buffer.alloc(0))], ['IEND', Buffer.alloc(0)],
  ]), 'invalid-container'],
  ['invalid depth/color combination', () => rasterPng({ depth: 4, color: 2 }), 'invalid-container'],
  ['late gAMA', () => rasterPng({ extraAfter: [['gAMA', Buffer.from([0, 0, 0, 0])]] }), 'invalid-container'],
  ['PLTE for grayscale', () => rasterPng({ color: 0, palette: Buffer.from([0, 0, 0]) }), 'invalid-container'],
  ['palette missing for indexed color', () => rasterPng({ color: 3, depth: 8 }), 'invalid-container'],
  ['tRNS on RGBA', () => rasterPng({ color: 6, extraBefore: [['tRNS', Buffer.alloc(6)]] }), 'invalid-container'],
  ['source with a DTD', () => withSource(base(), enc('<!DOCTYPE svg [<!ENTITY x "boom">]>' + SVG)), 'invalid-svg'],
  ['source not rooted at svg', () => withSource(base(), enc('<html/>')), 'invalid-svg'],
  ['oversize side', () => assemble([
    ['IHDR', ihdr(4097, 1, 8, 6)], ['IDAT', deflateSync(Buffer.alloc(8))], ['IEND', Buffer.alloc(0)],
  ]), 'resource-limit'],
  ['oversize pixel count', () => assemble([
    ['IHDR', ihdr(4096, 1025, 8, 6)], ['IDAT', deflateSync(Buffer.alloc(8))], ['IEND', Buffer.alloc(0)],
  ]), 'resource-limit'],
  ['decompressed source over the SVG cap', () => withSource(base(),
    enc('<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(1_000_001) + '</svg>')), 'resource-limit'],
  ['more than 10,000 chunks', () => {
    const note = ['tEXt', Buffer.from('a\0b')];
    return assemble([
      ['IHDR', ihdr(1, 1, 8, 6)],
      ...Array.from({ length: 10_001 }, () => note),
      ['IDAT', deflateSync(scanlines(1, 1, 8, 6, 0))], ['IEND', Buffer.alloc(0)],
    ]);
  }, 'resource-limit'],
];
for (const [name, build, expected] of REJECTS) {
  test(`container rejects: ${name}`, () => {
    assert.equal(parseCode(build()), expected);
  });
}

test('container accepts lenient language tags and ancillary chunks', () => {
  for (const language of ['en', 'ja', 'en-US', 'zh-Hant-TW', 'x-custom', 'en--US', 'abcdefghi']) {
    const doc = parseDocument(withSource(base(), enc(SVG), { language }));
    assert.deepEqual(Buffer.from(doc.source), Buffer.from(enc(SVG)), language);
  }
  const withAncillary = rasterPng({ extraBefore: [['abCD', Buffer.from('opaque')]] });
  assert.deepEqual(
    Buffer.from(parseDocument(withSource(withAncillary, enc(SVG))).source),
    Buffer.from(enc(SVG)),
  );
});

test('keyword case sensitivity: a differently-cased keyword is not a source', () => {
  const payload = Buffer.concat([
    Buffer.from('Vector-png.svg'), Buffer.from([0, 1, 0, 0, 0]), deflateSync(enc(SVG)),
  ]);
  const data = assemble([
    ['IHDR', ihdr(2, 2, 8, 6)], ['iTXt', payload],
    ['IDAT', deflateSync(scanlines(2, 2, 8, 6, 0))], ['IEND', Buffer.alloc(0)],
  ]);
  assert.equal(parseDocument(data).source, null);
});

test('raster geometry matrix is accepted across color types, depths, interlace', () => {
  const matrix = [
    [0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]],
  ];
  for (const [color, depths] of matrix) {
    for (const depth of depths) {
      for (const interlace of color === 3 && depth < 8 ? [0] : [0, 1]) {
        const palette = color === 3
          ? Buffer.alloc(3 * Math.min(2 ** depth, 4))
          : null;
        const data = rasterPng({ width: 3, height: 2, color, depth, interlace, palette });
        const doc = parseDocument(withSource(data, enc(SVG)));
        assert.equal(doc.color_type, color);
        assert.equal(doc.bit_depth, depth);
        assert.equal(doc.interlace, interlace);
      }
    }
  }
});

test('an Adam7 raster with a hand-built source parses, as in the Core audit', () => {
  const raw = scanlines(8, 8, 8, 6, 1);
  const data = assemble([
    ['IHDR', ihdr(8, 8, 8, 6, 1)],
    ['iTXt', itxtPayload(enc(SVG))],
    ['IDAT', deflateSync(raw)],
    ['IEND', Buffer.alloc(0)],
  ]);
  const doc = parseDocument(data);
  assert.equal(doc.interlace, 1);
  assert.deepEqual(Buffer.from(doc.source), Buffer.from(enc(SVG)));
});

test('out-of-range palette indices are accepted, matching PIL', () => {
  const raw = Buffer.from([0, 5, 5, 0, 5, 5]); // index 5, one-entry palette
  const data = assemble([
    ['IHDR', ihdr(2, 2, 8, 3)],
    ['PLTE', Buffer.from([255, 0, 0])],
    ['IDAT', deflateSync(raw)],
    ['IEND', Buffer.alloc(0)],
  ]);
  assert.equal(parseDocument(data).color_type, 3);
});

// --- build assembly ---

test('assembleVectorPng builds the Core layout and round-trips', () => {
  const built = assembleVectorPng(base(), enc(SVG));
  assert.deepEqual(
    parseChunks(built).map((c) => c.kind),
    ['IHDR', 'iTXt', 'IDAT', 'IEND'],
  );
  const doc = parseDocument(built);
  assert.deepEqual(Buffer.from(doc.source), Buffer.from(enc(SVG)));
  assert.equal(inspectDocument(built).kind, 'vector-png');
  // Rebuilding the assembled file reproduces it byte-for-byte.
  assert.deepEqual(rebuildVectorPng(built), built);
});

test('assembleVectorPng drops non-raster chunks from the raster', () => {
  const decorated = rasterPng({ extraBefore: [['tEXt', Buffer.from('note\0x')]] });
  const built = assembleVectorPng(decorated, enc(SVG));
  assert.deepEqual(
    parseChunks(built).map((c) => c.kind),
    ['IHDR', 'iTXt', 'IDAT', 'IEND'],
  );
});

test('an oversize file is a resource-limit before any parsing', () => {
  const big = Buffer.alloc(32_000_001);
  SIGNATURE.copy(big, 0);
  assert.equal(parseCode(big), 'resource-limit');
});
