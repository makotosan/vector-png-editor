// PNG construction helpers for the container tests. CRCs here use
// node:zlib's crc32 — an implementation independent of src/zlib.ts's
// table-driven one, so the two cross-validate each other, and the
// Python cross-check (tests/parity.test.mjs) validates both.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export const SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const KEY = 'vector-png.svg';

export function chunk(kind, payload) {
  const kindBytes = Buffer.from(kind, 'ascii');
  const body = Buffer.concat([kindBytes, payload]);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 8 + payload.length);
  return out;
}

export function assemble(parts) {
  return Buffer.concat([SIGNATURE, ...parts.map(([k, p]) => chunk(k, p))]);
}

export function ihdr(width, height, depth, color, interlace = 0) {
  const payload = Buffer.alloc(13);
  payload.writeUInt32BE(width, 0);
  payload.writeUInt32BE(height, 4);
  payload[8] = depth;
  payload[9] = color;
  payload[12] = interlace;
  return payload;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

/** Raw scanlines (filter 0, zero pixels) for a geometry, as the Core's audit builds them. */
export function scanlines(width, height, depth, color, interlace) {
  const channels = CHANNELS[color];
  const passes = interlace === 0 ? [[0, 0, 1, 1]] : ADAM7;
  const rows = [];
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.floor((width - x + dx - 1) / dx));
    const h = Math.max(0, Math.floor((height - y + dy - 1) / dy));
    if (!w || !h) continue;
    const row = Buffer.alloc(1 + Math.floor((w * channels * depth + 7) / 8));
    for (let r = 0; r < h; r++) rows.push(row);
  }
  return Buffer.concat(rows);
}

export function rasterPng({
  width = 2, height = 2, depth = 8, color = 6, interlace = 0,
  palette = null, extraBefore = [], extraAfter = [],
} = {}) {
  const parts = [['IHDR', ihdr(width, height, depth, color, interlace)]];
  if (palette) parts.push(['PLTE', palette]);
  parts.push(...extraBefore);
  parts.push(['IDAT', deflateSync(scanlines(width, height, depth, color, interlace))]);
  parts.push(...extraAfter);
  parts.push(['IEND', Buffer.alloc(0)]);
  return assemble(parts);
}

export function itxtPayload(
  source,
  { language = '', translated = '', flag = 1, method = 0, compressed = null } = {},
) {
  return Buffer.concat([
    Buffer.from(KEY, 'ascii'),
    Buffer.from([0, flag, method]),
    Buffer.from(language, 'latin1'),
    Buffer.from([0]),
    Buffer.from(translated, 'utf8'),
    Buffer.from([0]),
    compressed ?? deflateSync(source),
  ]);
}

export function withSource(raster, source, options = {}) {
  // Insert the iTXt right after IHDR by re-walking the raster bytes.
  const chunks = [];
  let pos = 8;
  const data = raster;
  while (pos < data.length) {
    const size = data.readUInt32BE(pos);
    const kind = data.toString('ascii', pos + 4, pos + 8);
    const payload = data.subarray(pos + 8, pos + 8 + size);
    chunks.push([kind, Buffer.from(payload)]);
    pos += 12 + size;
  }
  chunks.splice(1, 0, ['iTXt', itxtPayload(source, options)]);
  return assemble(chunks);
}

export { deflateSync, inflateSync };
