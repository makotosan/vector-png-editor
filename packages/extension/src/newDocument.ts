import { deflateSync } from 'node:zlib';
import { PNG_SIGNATURE, buildChunk, ihdrData } from './png.ts';
import { SOURCE_KEYWORD } from './detect.ts';

// New documents start at 1024x1024 with a transparent background
// (docs/ARCHITECTURE.md section 1). The embedded source is a minimal
// safe-svg-v1 document: an empty <svg> root with no elements, which the
// profile permits. Bytes are generated, never parsed from user input.
export const NEW_DOCUMENT_SIZE = 1024;
export const NEW_DOCUMENT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${NEW_DOCUMENT_SIZE}" height="${NEW_DOCUMENT_SIZE}"></svg>`;

function itxtSource(svg: string): Uint8Array {
  const keyword = new TextEncoder().encode(SOURCE_KEYWORD);
  const compressed = deflateSync(new TextEncoder().encode(svg));
  const out = new Uint8Array(keyword.length + 1 + 2 + 1 + 1 + compressed.length);
  let pos = 0;
  out.set(keyword, pos); pos += keyword.length;
  out[pos++] = 0; // keyword terminator
  out[pos++] = 1; // compression flag: compressed
  out[pos++] = 0; // compression method
  out[pos++] = 0; // language tag: empty, terminator
  out[pos++] = 0; // translated keyword: empty, terminator
  out.set(compressed, pos);
  return out;
}

export function buildNewDocumentPng(): Uint8Array {
  const size = NEW_DOCUMENT_SIZE;
  // RGBA scanlines: filter byte 0 followed by fully transparent pixels.
  const raw = new Uint8Array(size * (1 + size * 4));
  const idat = deflateSync(raw, { level: 9 });
  const parts = [
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdrData(size, size)),
    buildChunk('iTXt', itxtSource(NEW_DOCUMENT_SVG)),
    buildChunk('IDAT', idat),
    buildChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
