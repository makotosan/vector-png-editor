import { walkChunks } from './png.ts';

// Routing detection for vector-png files. This mirrors the container rules
// the Python Core enforces for the source chunk (exactly one compressed
// iTXt chunk with keyword "vector-png.svg") but stays passive: the SVG
// payload is never decompressed, parsed or executed here. Full validation
// remains the Core's job (inspect/validate).

export const SOURCE_KEYWORD = 'vector-png.svg';
const TEXT_TYPES = new Set(['iTXt', 'tEXt', 'zTXt']);

export type Detection =
  | { kind: 'vector-png'; width: number; height: number }
  | { kind: 'ordinary-png'; width: number; height: number }
  | { kind: 'corrupt-vector-png'; diagnostic: string }
  | { kind: 'not-png'; diagnostic: string };

function keywordOf(data: Uint8Array): string {
  const end = data.indexOf(0);
  const raw = end === -1 ? data : data.subarray(0, end);
  return new TextDecoder('latin1').decode(raw);
}

export function detectPng(bytes: Uint8Array): Detection {
  const walk = walkChunks(bytes);
  if (!walk.ok) {
    // A file that carries the source keyword but fails chunk structure is a
    // corrupt vector-png, not an ordinary PNG: surface a diagnostic.
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1_000_000)));
    if (text.includes(SOURCE_KEYWORD))
      return { kind: 'corrupt-vector-png', diagnostic: `Invalid PNG container: ${walk.reason}` };
    return { kind: 'not-png', diagnostic: walk.reason };
  }
  const chunks = walk.chunks;
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== 'IHDR' || ihdr.data.length !== 13)
    return { kind: 'not-png', diagnostic: 'Missing PNG IHDR' };
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = view.getUint32(0), height = view.getUint32(4);
  if (width === 0 || height === 0) return { kind: 'not-png', diagnostic: 'Zero PNG dimension' };

  const sources = chunks.filter(c => TEXT_TYPES.has(c.type) && keywordOf(c.data) === SOURCE_KEYWORD);
  if (sources.length === 0) return { kind: 'ordinary-png', width, height };
  if (sources.length > 1)
    return { kind: 'corrupt-vector-png', diagnostic: `Expected exactly one ${SOURCE_KEYWORD} source chunk, found ${sources.length}` };
  const source = sources[0];
  if (source.type !== 'iTXt')
    return { kind: 'corrupt-vector-png', diagnostic: `SVG source must use iTXt, found ${source.type}` };
  // iTXt layout: keyword, NUL, compression flag, compression method,
  // language tag, NUL, translated keyword, NUL, text.
  const rest = source.data.subarray(SOURCE_KEYWORD.length + 1);
  if (rest.length < 2 || rest[0] !== 1 || rest[1] !== 0)
    return { kind: 'corrupt-vector-png', diagnostic: 'SVG source requires compressed iTXt with compression method 0' };
  return { kind: 'vector-png', width, height };
}
