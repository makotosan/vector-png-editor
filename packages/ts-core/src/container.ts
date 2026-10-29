// PNG container handling, mirroring the Python Core's document.py
// (passive discovery and exact source extraction) and the container
// assembly of writing.py's build candidate.
//
// Error codes are the Core's own (errors.py / document.py):
// 'invalid-container' covers every structural rejection — bad
// signature, CRC mismatch, truncation, duplicate source chunk and
// the rest are one code with distinct messages in the Core, and so
// here; 'resource-limit' covers the size/count caps;
// 'ordinary-png' is a well-formed PNG with no vector-png source.
//
// Two behaviour notes:
// - Reading validates the embedded source with the bounded XML
//   parser (parseSource) exactly as the Core does: a vector-png
//   whose source is not well-formed SVG-rooted XML is rejected
//   during passive discovery, while a profile-unsafe source (e.g.
//   containing <script>) extracts fine — profile acceptance is
//   validate.ts's job, not the container's.
// - The Core's final read step decodes the raster with PIL
//   (verify + load) after its own zlib/scanline checks. The mirror
//   here is rasterStream's exact-length/filter validation plus a
//   full unfilter decode of every pass; palette indices are not
//   range-checked, matching PIL (verified against the Core).
import { createHash } from 'node:crypto';
import { TsCoreError } from './errors.ts';
import { crc32, deflate, inflateBounded } from './zlib.ts';
import { MAX_SVG, parseSource } from './xml.ts';

export const SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const KEY = 'vector-png.svg';
const KEY_BYTES = new TextEncoder().encode(KEY);
export const MAX_PNG = 32_000_000;
export const MAX_SIDE = 4096;
export const MAX_PIXELS = 4_000_000;
export const MAX_CHUNKS = 10_000;

const PRE_PALETTE = new Set([
  'cHRM', 'cICP', 'gAMA', 'iCCP', 'mDCV', 'cLLI', 'sBIT', 'sRGB',
]);
const PRE_IDAT = new Set([
  ...PRE_PALETTE,
  'bKGD', 'hIST', 'tRNS', 'pHYs', 'sPLT', 'eXIf',
]);
const SINGLETON = new Set([
  ...[...PRE_IDAT].filter((kind) => kind !== 'sPLT'),
  'IHDR', 'PLTE', 'IEND', 'tIME', 'eXIf',
]);
const RASTER_KINDS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const TEXT_KINDS = new Set(['iTXt', 'tEXt', 'zTXt']);
const APNG_KINDS = new Set(['acTL', 'fcTL', 'fdAT']);
const DEPTHS: Record<number, Set<number>> = {
  0: new Set([1, 2, 4, 8, 16]),
  2: new Set([8, 16]),
  3: new Set([1, 2, 4, 8]),
  4: new Set([8, 16]),
  6: new Set([8, 16]),
};
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface PngChunk {
  kind: string;
  payload: Uint8Array;
}

export interface PngDocument {
  source: Uint8Array | null;
  width: number;
  height: number;
  png_sha256: string;
  color_type: number;
  bit_depth: number;
  interlace: number;
}

export interface PngInspect {
  kind: 'vector-png' | 'png';
  wire: 'v1' | null;
  container: 'passed-supported-checks';
  profile: 'not-checked';
  preview: 'not-checked';
  width: number;
  height: number;
  color_type: number;
  bit_depth: number;
  interlace: number;
  png_sha256: string;
  svg_bytes: number;
  svg_sha256: string | null;
}

function u32be(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function concatBytes(parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts);
}

function serializeChunk(kind: string, payload: Uint8Array): Buffer {
  const kindBytes = new TextEncoder().encode(kind);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.set(kindBytes, 4);
  out.set(payload, 8);
  const crcInput = concatBytes([kindBytes, payload]);
  out.writeUInt32BE(crc32(crcInput), 8 + payload.length);
  return out;
}

/**
 * The Core's chunks(): liberal chunk walking with CRC verification.
 * Returns every chunk in order; throws TsCoreError
 * ('invalid-container' / 'resource-limit') on any structural flaw.
 */
export function parseChunks(data: Uint8Array): PngChunk[] {
  if (
    data.length < SIGNATURE.length ||
    !SIGNATURE.every((byte, index) => data[index] === byte)
  ) {
    throw new TsCoreError('invalid-container', 'Not a PNG');
  }
  const chunks: PngChunk[] = [];
  let pos = 8;
  let count = 0;
  while (pos + 12 <= data.length) {
    count += 1;
    if (count > MAX_CHUNKS) {
      throw new TsCoreError('resource-limit', 'PNG exceeds 10,000 chunks');
    }
    const size = u32be(data, pos);
    const kindBytes = data.subarray(pos + 4, pos + 8);
    const kind = String.fromCharCode(...kindBytes);
    const end = pos + 8 + size;
    if (size > 0x7fffffff || end + 4 > data.length) {
      throw new TsCoreError(
        'invalid-container',
        'Truncated or oversized PNG chunk',
      );
    }
    if (!/^[A-Za-z]{4}$/.test(kind) || (kindBytes[2] & 32) !== 0) {
      throw new TsCoreError('invalid-container', 'Invalid PNG chunk type');
    }
    const payload = data.subarray(pos + 8, end);
    const crc = u32be(data, end);
    if (crc32(concatBytes([kindBytes, payload])) !== crc) {
      throw new TsCoreError('invalid-container', 'Invalid PNG CRC');
    }
    chunks.push({ kind, payload });
    pos = end + 4;
    if (kind === 'IEND') {
      if (size !== 0 || pos !== data.length) {
        throw new TsCoreError('invalid-container', 'Invalid PNG ending');
      }
      return chunks;
    }
  }
  throw new TsCoreError('invalid-container', 'Missing PNG IEND');
}

function textKeyword(payload: Uint8Array): Uint8Array {
  const nul = payload.indexOf(0);
  return nul === -1 ? payload : payload.subarray(0, nul);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** The Core's source_payload(): decode and validate the source chunk. */
function sourcePayload(payload: Uint8Array): Uint8Array {
  let raw: Uint8Array;
  try {
    const rest = payload.subarray(KEY_BYTES.length + 1);
    if (rest.length < 2 || rest[0] !== 0x01 || rest[1] !== 0x00) {
      throw new Error('SVG requires compressed iTXt with method 0');
    }
    const body = rest.subarray(2);
    const firstNul = body.indexOf(0);
    const secondNul =
      firstNul === -1 ? -1 : body.indexOf(0, firstNul + 1);
    if (firstNul === -1 || secondNul === -1) {
      throw new Error('SVG iTXt is missing its text fields');
    }
    const language = body.subarray(0, firstNul);
    const translated = body.subarray(firstNul + 1, secondNul);
    const compressed = body.subarray(secondNul + 1);
    // Registry-level BCP 47 validation is an explicit non-goal for
    // wire v1, exactly as in the Core: ASCII is all that is checked.
    if (language.some((byte) => byte >= 0x80)) {
      throw new Error('SVG iTXt language tag is not ASCII');
    }
    new TextDecoder('utf-8', { fatal: true }).decode(translated);
    const outcome = inflateBounded(compressed, MAX_SVG + 1);
    if (outcome.status === 'overflow') {
      throw new TsCoreError(
        'resource-limit',
        'SVG exceeds decompression limit',
      );
    }
    if (outcome.status === 'invalid') {
      throw new Error('SVG must contain exactly one complete zlib stream');
    }
    if (outcome.output.length > MAX_SVG) {
      throw new TsCoreError(
        'resource-limit',
        'SVG exceeds decompression limit',
      );
    }
    raw = outcome.output;
  } catch (error) {
    if (error instanceof TsCoreError) throw error;
    throw new TsCoreError(
      'invalid-container',
      `Invalid SVG iTXt: ${(error as Error).message}`,
    );
  }
  parseSource(raw);
  return raw;
}

const ADAM7_PASSES: Array<[number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function passDimensions(
  width: number,
  height: number,
  interlace: number,
): Array<{ w: number; h: number }> {
  const passes =
    interlace === 0 ? [[0, 0, 1, 1] as const] : ADAM7_PASSES;
  return passes.map(([x, y, dx, dy]) => ({
    w: Math.max(0, Math.floor((width - x + dx - 1) / dx)),
    h: Math.max(0, Math.floor((height - y + dy - 1) / dy)),
  }));
}

/**
 * The Core's raster_stream(): validate the IDAT zlib stream against
 * the exact scanline geometry, then keep only the raster chunks.
 * Returns the raster-only PNG bytes and the raw scanlines.
 */
function rasterStream(
  stream: PngChunk[],
  width: number,
  height: number,
  depth: number,
  color: number,
  interlace: number,
): { raster: Buffer; scanlines: Buffer } {
  const channels = CHANNELS[color];
  const rowSizes: number[] = [];
  for (const { w, h } of passDimensions(width, height, interlace)) {
    if (w && h) {
      const size = 1 + Math.floor((w * channels * depth + 7) / 8);
      for (let r = 0; r < h; r++) rowSizes.push(size);
    }
  }
  const expected = rowSizes.reduce((sum, size) => sum + size, 0);
  const compressed = concatBytes(
    stream.filter((chunk) => chunk.kind === 'IDAT').map((c) => c.payload),
  );
  const outcome = inflateBounded(compressed, expected + 1);
  if (outcome.status !== 'ok' || outcome.output.length !== expected) {
    throw new TsCoreError(
      'invalid-container',
      'Invalid PNG image zlib stream or scanline size',
    );
  }
  const raw = outcome.output;
  let pos = 0;
  for (const size of rowSizes) {
    if (raw[pos] > 4) {
      throw new TsCoreError('invalid-container', 'Invalid PNG filter type');
    }
    pos += size;
  }
  // Decode only raster chunks. Text/ICC metadata must not inflate
  // during passive discovery.
  const parts: Uint8Array[] = [SIGNATURE];
  for (const chunk of stream) {
    if (RASTER_KINDS.has(chunk.kind)) {
      parts.push(serializeChunk(chunk.kind, chunk.payload));
    }
  }
  return { raster: concatBytes(parts), scanlines: raw };
}

/**
 * The Core's PIL verify+load step, mirrored as a full unfilter
 * decode of every pass: any structural inconsistency in the
 * scanlines surfaces here. Pixel values are not interpreted (and
 * palette indices are not range-checked — PIL accepts those).
 */
function assertRasterDecodable(
  scanlines: Uint8Array,
  width: number,
  height: number,
  depth: number,
  color: number,
  interlace: number,
): void {
  const channels = CHANNELS[color];
  const bytesPerPixel = Math.max(1, Math.floor((channels * depth + 7) / 8));
  let pos = 0;
  for (const { w, h } of passDimensions(width, height, interlace)) {
    if (!w || !h) continue;
    const rowBytes = Math.floor((w * channels * depth + 7) / 8);
    let previous = new Uint8Array(rowBytes);
    for (let r = 0; r < h; r++) {
      const filter = scanlines[pos];
      const row = scanlines.subarray(pos + 1, pos + 1 + rowBytes);
      const recon = new Uint8Array(rowBytes);
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bytesPerPixel ? recon[i - bytesPerPixel] : 0;
        const up = previous[i];
        const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = Math.floor((left + up) / 2);
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        recon[i] = (row[i] + predictor) & 0xff;
      }
      previous = recon;
      pos += 1 + rowBytes;
    }
  }
}

/**
 * Mirror of the Core's read_document_bytes(): full passive
 * validation of the container and (when present) its source.
 */
export function parseDocument(data: Uint8Array): PngDocument {
  if (data.length > MAX_PNG) {
    throw new TsCoreError('resource-limit', 'PNG exceeds byte limit');
  }
  const stream = parseChunks(data);
  if (
    stream.length === 0 ||
    stream[0].kind !== 'IHDR' ||
    stream[0].payload.length !== 13
  ) {
    throw new TsCoreError('invalid-container', 'Missing PNG IHDR');
  }
  const ihdr = stream[0].payload;
  const width = u32be(ihdr, 0);
  const height = u32be(ihdr, 4);
  const depth = ihdr[8];
  const color = ihdr[9];
  const compression = ihdr[10];
  const filtering = ihdr[11];
  const interlace = ihdr[12];
  if (width === 0 || height === 0) {
    throw new TsCoreError('invalid-container', 'Zero PNG dimension');
  }
  if (Math.max(width, height) > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new TsCoreError(
      'resource-limit',
      'PNG exceeds side/pixel limits',
    );
  }
  if (
    !DEPTHS[color]?.has(depth) ||
    compression !== 0 ||
    filtering !== 0 ||
    (interlace !== 0 && interlace !== 1)
  ) {
    throw new TsCoreError('invalid-container', 'Invalid PNG IHDR fields');
  }
  const seen = new Set<string>();
  let idatStarted = false;
  let idatEnded = false;
  let paletteEntries: number | null = null;
  let source: Uint8Array | null = null;
  let sourceCount = 0;
  for (const { kind, payload } of stream) {
    if (APNG_KINDS.has(kind)) {
      throw new TsCoreError(
        'invalid-container',
        'APNG markers are forbidden',
      );
    }
    if (
      (kind.charCodeAt(0) & 32) === 0 &&
      !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(kind)
    ) {
      throw new TsCoreError(
        'invalid-container',
        'Unknown critical PNG chunk',
      );
    }
    if (SINGLETON.has(kind) && seen.has(kind)) {
      throw new TsCoreError(
        'invalid-container',
        'Duplicate PNG singleton chunk',
      );
    }
    if (
      (PRE_PALETTE.has(kind) && seen.has('PLTE')) ||
      (PRE_IDAT.has(kind) && idatStarted)
    ) {
      throw new TsCoreError(
        'invalid-container',
        'Invalid ancillary PNG chunk ordering',
      );
    }
    if (kind === 'PLTE') {
      if (
        idatStarted ||
        color === 0 ||
        color === 4 ||
        payload.length === 0 ||
        payload.length % 3 !== 0 ||
        payload.length > 768
      ) {
        throw new TsCoreError('invalid-container', 'Invalid PLTE');
      }
      paletteEntries = payload.length / 3;
      if (color === 3 && paletteEntries > 2 ** depth) {
        throw new TsCoreError(
          'invalid-container',
          'Palette exceeds bit depth',
        );
      }
      if (seen.has('bKGD') || seen.has('tRNS')) {
        throw new TsCoreError(
          'invalid-container',
          'PLTE must precede bKGD/tRNS',
        );
      }
    }
    if (
      kind === 'hIST' &&
      (paletteEntries === null || payload.length !== 2 * paletteEntries)
    ) {
      throw new TsCoreError('invalid-container', 'Invalid hIST');
    }
    if (kind === 'tRNS') {
      if (
        color === 4 ||
        color === 6 ||
        (color === 0 && payload.length !== 2) ||
        (color === 2 && payload.length !== 6) ||
        (color === 3 &&
          (paletteEntries === null ||
            payload.length < 1 ||
            payload.length > paletteEntries))
      ) {
        throw new TsCoreError('invalid-container', 'Invalid tRNS');
      }
    }
    if (kind === 'IDAT') {
      if (idatEnded || (color === 3 && paletteEntries === null)) {
        throw new TsCoreError(
          'invalid-container',
          'Nonconsecutive IDAT or missing PLTE',
        );
      }
      idatStarted = true;
    } else if (idatStarted) {
      idatEnded = true;
    }
    if (TEXT_KINDS.has(kind) && bytesEqual(textKeyword(payload), KEY_BYTES)) {
      sourceCount += 1;
      if (kind !== 'iTXt' || sourceCount > 1) {
        throw new TsCoreError(
          'invalid-container',
          'SVG must use exactly one iTXt source chunk',
        );
      }
      source = sourcePayload(payload);
    }
    seen.add(kind);
  }
  if (!idatStarted) {
    throw new TsCoreError('invalid-container', 'Missing PNG IDAT');
  }
  const { scanlines } = rasterStream(
    stream,
    width,
    height,
    depth,
    color,
    interlace,
  );
  try {
    assertRasterDecodable(scanlines, width, height, depth, color, interlace);
  } catch {
    throw new TsCoreError(
      'invalid-container',
      'Invalid or unsupported PNG raster/metadata',
    );
  }
  return {
    source,
    width,
    height,
    png_sha256: sha256Hex(data),
    color_type: color,
    bit_depth: depth,
    interlace,
  };
}

/** Mirror of the Core's inspect_document report (on bytes). */
export function inspectDocument(data: Uint8Array): PngInspect {
  const doc = parseDocument(data);
  return {
    kind: doc.source !== null ? 'vector-png' : 'png',
    wire: doc.source !== null ? 'v1' : null,
    container: 'passed-supported-checks',
    profile: 'not-checked',
    preview: 'not-checked',
    width: doc.width,
    height: doc.height,
    color_type: doc.color_type,
    bit_depth: doc.bit_depth,
    interlace: doc.interlace,
    png_sha256: doc.png_sha256,
    svg_bytes: doc.source !== null ? doc.source.length : 0,
    svg_sha256: doc.source !== null ? sha256Hex(doc.source) : null,
  };
}

/**
 * The source bytes of a vector-png, byte-exact. The Core's
 * extract_source additionally publishes them to a new file without
 * overwriting; that file-publication policy belongs to the caller,
 * as it does in the extension today.
 */
export function extractSource(data: Uint8Array): Uint8Array {
  const doc = parseDocument(data);
  if (doc.source === null) {
    throw new TsCoreError(
      'ordinary-png',
      'PNG contains no vector-png.svg source',
    );
  }
  return doc.source;
}

function itxtPayload(source: Uint8Array): Buffer {
  return concatBytes([
    KEY_BYTES,
    new Uint8Array([0, 1, 0, 0, 0]),
    deflate(source),
  ]);
}

/**
 * The container assembly of the Core's build candidate
 * (writing._candidate): keep only the raster chunks of the given
 * raster PNG, in order, and insert the source iTXt immediately
 * after IHDR. The Core's candidate then self-verifies by rendering;
 * that render/verify step belongs to the (separate) verify path.
 * Note the compressed source bytes come from this platform's zlib
 * (see zlib.ts): the file is a valid vector-png whose source
 * round-trips byte-exactly, but its bytes need not equal a Python
 * build's. Use rebuildVectorPng to reproduce an existing file.
 */
export function assembleVectorPng(
  rasterPng: Uint8Array,
  source: Uint8Array,
): Buffer {
  const stream = parseChunks(rasterPng);
  const parts: Uint8Array[] = [SIGNATURE];
  for (const chunk of stream) {
    if (!RASTER_KINDS.has(chunk.kind)) continue;
    parts.push(serializeChunk(chunk.kind, chunk.payload));
    if (chunk.kind === 'IHDR') {
      parts.push(serializeChunk('iTXt', itxtPayload(source)));
    }
  }
  return concatBytes(parts);
}

/**
 * Reassemble a parsed vector-png the way the Core's build does —
 * raster chunks only, source directly after IHDR — preserving the
 * original iTXt payload verbatim. For a file the Core built this
 * reproduces the input byte-for-byte: chunk order and contents are
 * the build's own, and no recompression is involved.
 */
export function rebuildVectorPng(data: Uint8Array): Buffer {
  const doc = parseDocument(data);
  if (doc.source === null) {
    throw new TsCoreError(
      'ordinary-png',
      'PNG contains no vector-png.svg source',
    );
  }
  const stream = parseChunks(data);
  const sourceChunk = stream.find(
    (chunk) =>
      chunk.kind === 'iTXt' &&
      bytesEqual(textKeyword(chunk.payload), KEY_BYTES),
  )!;
  const parts: Uint8Array[] = [SIGNATURE];
  for (const chunk of stream) {
    if (!RASTER_KINDS.has(chunk.kind)) continue;
    parts.push(serializeChunk(chunk.kind, chunk.payload));
    if (chunk.kind === 'IHDR') {
      parts.push(serializeChunk('iTXt', sourceChunk.payload));
    }
  }
  return concatBytes(parts);
}
