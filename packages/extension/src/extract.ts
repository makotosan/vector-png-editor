import { extractSource as extractCoreSource } from '../../ts-core/src/container.ts';
import { MAX_SVG_BYTES } from './profile.ts';

// Exact source extraction for the editor, delegated to the
// TypeScript Core's container (packages/ts-core): its read performs
// the Core's full passive validation - chunk structure, the single
// compressed iTXt source chunk, bounded decompression, and the
// bounded XML well-formedness check the Core applies during
// discovery (profile acceptance is validation's job, not the
// container's, exactly as in the Core). The extraction preserves
// the source bytes exactly (BOM and newlines included); the text is
// data for the editor model only and is never inserted into a DOM.
export type ExtractedSource = {
  sourceBytes: Uint8Array;
  text: string;
  hasBom: boolean;
  newline: 'crlf' | 'lf' | 'mixed' | 'none';
};

export class ExtractError extends Error {}

export function extractSource(bytes: Uint8Array, maxSvgBytes: number = MAX_SVG_BYTES): ExtractedSource {
  let sourceBytes: Uint8Array;
  try {
    sourceBytes = extractCoreSource(bytes);
  } catch (error) {
    throw new ExtractError(error instanceof Error ? error.message : String(error));
  }
  if (sourceBytes.length > maxSvgBytes) throw new ExtractError(`SVG source exceeds ${maxSvgBytes} bytes`);
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
