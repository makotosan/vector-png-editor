import { KEY, MAX_PNG, parseChunks } from '../../ts-core/src/container.ts';
import { TsCoreError } from '../../ts-core/src/errors.ts';

// Routing detection for vector-png files. The chunk walk is the
// TypeScript Core's container walk (packages/ts-core) - the same
// liberal, CRC-checked walk the Core itself performs - but the
// detection layer stays passive: the SVG payload is never
// decompressed, parsed or executed here, and a structurally sound
// container routes as vector-png whatever its payload holds. Full
// validation remains the Core's job (container/profile/render).
// The detection vocabulary (vector-png / ordinary-png /
// corrupt-vector-png / not-png) is this layer's own.

export const SOURCE_KEYWORD = KEY;
const TEXT_TYPES = new Set(['iTXt', 'tEXt', 'zTXt']);
const KEY_BYTES = new TextEncoder().encode(KEY);

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
  let chunks;
  try {
    if (bytes.length > MAX_PNG) throw new TsCoreError('resource-limit', 'PNG exceeds byte limit');
    chunks = parseChunks(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A file that carries the source keyword but fails chunk structure is a
    // corrupt vector-png, not an ordinary PNG: surface a diagnostic.
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1_000_000)));
    if (text.includes(SOURCE_KEYWORD))
      return { kind: 'corrupt-vector-png', diagnostic: `Invalid PNG container: ${reason}` };
    return { kind: 'not-png', diagnostic: reason };
  }
  const ihdr = chunks[0];
  if (!ihdr || ihdr.kind !== 'IHDR' || ihdr.payload.length !== 13)
    return { kind: 'not-png', diagnostic: 'Missing PNG IHDR' };
  const view = new DataView(ihdr.payload.buffer, ihdr.payload.byteOffset, ihdr.payload.byteLength);
  const width = view.getUint32(0), height = view.getUint32(4);
  if (width === 0 || height === 0) return { kind: 'not-png', diagnostic: 'Zero PNG dimension' };

  const sources = chunks.filter(c => TEXT_TYPES.has(c.kind) && keywordOf(c.payload) === SOURCE_KEYWORD);
  if (sources.length === 0) return { kind: 'ordinary-png', width, height };
  if (sources.length > 1)
    return { kind: 'corrupt-vector-png', diagnostic: `Expected exactly one ${SOURCE_KEYWORD} source chunk, found ${sources.length}` };
  const source = sources[0];
  if (source.kind !== 'iTXt')
    return { kind: 'corrupt-vector-png', diagnostic: `SVG source must use iTXt, found ${source.kind}` };
  // iTXt layout: keyword, NUL, compression flag, compression method,
  // language tag, NUL, translated keyword, NUL, text.
  const rest = source.payload.subarray(KEY_BYTES.length + 1);
  if (rest.length < 2 || rest[0] !== 1 || rest[1] !== 0)
    return { kind: 'corrupt-vector-png', diagnostic: 'SVG source requires compressed iTXt with compression method 0' };
  return { kind: 'vector-png', width, height };
}
