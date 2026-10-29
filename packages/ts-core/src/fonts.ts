// Font ingestion for the TypeScript Core renderer.
//
// The renderer (@resvg/resvg-wasm) takes raw font buffers per Resvg
// construction; which buffers are supplied decides how text renders,
// so font selection is an explicit host responsibility (see the
// Issue #57 spike notes). This module is the single ingestion path:
// callers name font files (plus the family/style/weight they know
// those files to be), and get FontBuffer records the renderer
// consumes. The metadata is caller-supplied — this slice does not
// parse font name tables — and is carried for later integration
// (logging, font-strategy decisions); resvg itself reads the family
// from the font data.
import { readFile } from 'node:fs/promises';

export interface FontBuffer {
  /** Raw font file bytes (TTF/OTF, or a TTC collection). */
  data: Uint8Array;
  /** Family the caller knows this file to provide, if stated. */
  family?: string;
  /** CSS style descriptor, e.g. 'normal' or 'italic', if stated. */
  style?: string;
  /** CSS weight (100–900) this file provides, if stated. */
  weight?: number;
}

export interface FontFileSpec {
  path: string;
  family?: string;
  style?: string;
  weight?: number;
}

/** Read one font file into a FontBuffer. */
export async function loadFontBuffer(spec: string | FontFileSpec): Promise<FontBuffer> {
  const { path, family, style, weight } = typeof spec === 'string' ? { path: spec } as FontFileSpec : spec;
  const data = new Uint8Array(await readFile(path));
  const buffer: FontBuffer = { data };
  if (family !== undefined) buffer.family = family;
  if (style !== undefined) buffer.style = style;
  if (weight !== undefined) buffer.weight = weight;
  return buffer;
}

/** Read font files into the FontBuffer list the renderer consumes. */
export async function loadFontBuffers(
  specs: readonly (string | FontFileSpec)[],
): Promise<FontBuffer[]> {
  const buffers: FontBuffer[] = [];
  for (const spec of specs) buffers.push(await loadFontBuffer(spec));
  return buffers;
}
