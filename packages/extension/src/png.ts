// Minimal, bounded PNG chunk walking and building.
// Detection never decompresses or parses the embedded SVG: it only inspects
// chunk structure so that opening a file can never execute source content.

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_PNG_BYTES = 32_000_000;
export const MAX_CHUNKS = 10_000;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type PngChunk = { type: string; data: Uint8Array; offset: number };

export type ChunkWalk =
  | { ok: true; chunks: PngChunk[] }
  | { ok: false; reason: string };

export function walkChunks(bytes: Uint8Array): ChunkWalk {
  if (bytes.length > MAX_PNG_BYTES) return { ok: false, reason: `PNG exceeds ${MAX_PNG_BYTES} bytes` };
  if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((b, i) => bytes[i] === b))
    return { ok: false, reason: 'Not a PNG file (bad signature)' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let pos = PNG_SIGNATURE.length;
  while (pos + 12 <= bytes.length) {
    if (chunks.length >= MAX_CHUNKS) return { ok: false, reason: `PNG exceeds ${MAX_CHUNKS} chunks` };
    const size = view.getUint32(pos);
    if (size > 0x7fffffff) return { ok: false, reason: 'Oversized PNG chunk' };
    const typeBytes = bytes.subarray(pos + 4, pos + 8);
    const type = String.fromCharCode(...typeBytes);
    if (!/^[A-Za-z]{4}$/.test(type) || (typeBytes[2] & 32) !== 0)
      return { ok: false, reason: `Invalid PNG chunk type at offset ${pos}` };
    const end = pos + 8 + size;
    if (end + 4 > bytes.length) return { ok: false, reason: 'Truncated PNG chunk' };
    const data = bytes.subarray(pos + 8, end);
    const expected = view.getUint32(end);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes, 0); crcInput.set(data, 4);
    if (crc32(crcInput) !== expected) return { ok: false, reason: `Invalid CRC in ${type} chunk` };
    chunks.push({ type, data, offset: pos });
    pos = end + 4;
    if (type === 'IEND') {
      if (size !== 0 || pos !== bytes.length) return { ok: false, reason: 'Invalid PNG ending' };
      return { ok: true, chunks };
    }
  }
  return { ok: false, reason: 'Missing PNG IEND' };
}

export function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

export function ihdrData(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  data[8] = 8;   // bit depth
  data[9] = 6;   // colour type RGBA
  data[10] = 0;  // compression
  data[11] = 0;  // filter
  data[12] = 0;  // interlace
  return data;
}
