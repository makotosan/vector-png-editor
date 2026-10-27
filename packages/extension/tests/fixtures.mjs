import { deflateSync } from 'node:zlib';
import { PNG_SIGNATURE, buildChunk, ihdrData } from '../src/png.ts';
import { SOURCE_KEYWORD } from '../src/detect.ts';

export function assemble(chunks) {
  const parts = [PNG_SIGNATURE, ...chunks];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export function idatFor(width, height) {
  return buildChunk('IDAT', deflateSync(new Uint8Array(height * (1 + width * 4))));
}

export function ordinaryPng(width = 2, height = 2) {
  return assemble([buildChunk('IHDR', ihdrData(width, height)), idatFor(width, height), buildChunk('IEND', new Uint8Array(0))]);
}

export function itxt(svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>', overrides = {}) {
  const keyword = new TextEncoder().encode(SOURCE_KEYWORD);
  const flag = overrides.flag ?? 1, method = overrides.method ?? 0;
  const payload = overrides.rawPayload ?? deflateSync(new TextEncoder().encode(svg));
  const out = new Uint8Array(keyword.length + 1 + 2 + 1 + 1 + payload.length);
  let pos = 0;
  out.set(keyword, pos); pos += keyword.length;
  out[pos++] = 0; out[pos++] = flag; out[pos++] = method; out[pos++] = 0; out[pos++] = 0;
  out.set(payload, pos);
  return buildChunk(overrides.chunkType ?? 'iTXt', out);
}

export function vectorPng(width = 2, height = 2) {
  return assemble([buildChunk('IHDR', ihdrData(width, height)), itxt(), idatFor(width, height), buildChunk('IEND', new Uint8Array(0))]);
}
