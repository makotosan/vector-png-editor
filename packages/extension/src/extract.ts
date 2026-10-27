import { inflateSync } from 'node:zlib';
import { walkChunks } from './png.ts';
import { SOURCE_KEYWORD } from './detect.ts';
import { MAX_SVG_BYTES } from './profile.ts';

// Exact source extraction for the editor. Unlike routing detection, opening
// a document decompresses the iTXt payload - with a hard output bound - and
// preserves the source bytes exactly (BOM and newlines included). The text
// is data for the editor model only; it is never inserted into a DOM.
export type ExtractedSource = {
  sourceBytes: Uint8Array;
  text: string;
  hasBom: boolean;
  newline: 'crlf' | 'lf' | 'mixed' | 'none';
};

export class ExtractError extends Error {}

export function extractSource(bytes: Uint8Array, maxSvgBytes: number = MAX_SVG_BYTES): ExtractedSource {
  const walk = walkChunks(bytes);
  if (!walk.ok) throw new ExtractError(`Invalid PNG container: ${walk.reason}`);
  const sources = walk.chunks.filter(c => c.type === 'iTXt'
    && new TextDecoder('latin1').decode(c.data.subarray(0, c.data.indexOf(0))) === SOURCE_KEYWORD);
  if (sources.length !== 1) throw new ExtractError(`Expected exactly one ${SOURCE_KEYWORD} source chunk, found ${sources.length}`);
  const data = sources[0].data;
  const payloadStart = SOURCE_KEYWORD.length + 1 + 2 + 1 + 1;
  let raw: Buffer;
  try {
    raw = inflateSync(data.subarray(payloadStart), { maxOutputLength: maxSvgBytes + 1 });
  } catch {
    throw new ExtractError('SVG source is not a valid compressed iTXt payload');
  }
  if (raw.length > maxSvgBytes) throw new ExtractError(`SVG source exceeds ${maxSvgBytes} bytes`);
  const sourceBytes = new Uint8Array(raw);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceBytes);
  } catch {
    throw new ExtractError('SVG source is not valid UTF-8');
  }
  const hasBom = sourceBytes[0] === 0xef && sourceBytes[1] === 0xbb && sourceBytes[2] === 0xbf;
  const body = hasBom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const loneLf = (body.match(/(?<!\r)\n/g) ?? []).length;
  const newline = crlf && loneLf ? 'mixed' : crlf ? 'crlf' : loneLf ? 'lf' : 'none';
  return { sourceBytes, text, hasBom, newline };
}
