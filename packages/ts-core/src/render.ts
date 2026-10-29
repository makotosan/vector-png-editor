// SVG → PNG rendering for the TypeScript Core, on @resvg/resvg-wasm.
//
// This replaces the Python Core's CairoSVG render path
// (rendering.render_source → _backend._render_worker) for the
// migration in Issues #58/#61. The Issue #57 spike verified resvg
// renders the project corpus equivalently (dimensions identical,
// alpha channel identical); renderer-conformance re-verification is
// tracked separately and is not repeated here.
//
// Two behaviours of the Cairo path are NOT provided by resvg and
// are enforced here, before the engine ever sees the source:
//
// 1. Resource caps. resvg enforces no limits (spike probe 4: it
//    rendered 5000 px wide and 6.25 Mpx viewports without error),
//    so the Core's caps are checked up front, mirroring
//    rendering.render_source: integer sides, each side within
//    1..4096, and width * height <= 4,000,000. Violations throw
//    TsCoreError with code 'resource-limit' and the Core's message.
// 2. External references. Cairo's gate path renders with a
//    deny-fetch fetcher, so an external reference is an error.
//    resvg instead renders successfully and silently drops what it
//    cannot resolve (spike probe 5) — a silent loss this project
//    never accepts. Any href / xlink:href whose value does not
//    start with '#', and any url(...) reference that is not a
//    local fragment, is rejected with code 'external-reference'.
//    The scan is deliberately conservative: it runs over the raw
//    source string, so it also sees attributes, <style> content
//    and style attributes — and, as a documented false positive,
//    would also flag reference-shaped text inside comments or
//    text content. Failing loudly on an ambiguous source is the
//    intended side of the line for a render gate.
//
// Rendering mirrors the spike's Resvg setup: the supplied font
// buffers are passed per construction with loadSystemFonts off,
// the font-family defaults are the spike's ("Noto Sans"), and no
// background is set, so the output background is transparent,
// matching the Core's gate path. The requested size is applied as
// fitTo width; resvg scales uniformly, so width/height must be
// the document's own viewport (as the Core's callers derive it).
// A result whose dimensions differ from the request — only
// possible when the request is not the document's aspect — is a
// 'render-failed' error, never a silently stretched image.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { TsCoreError } from './errors.ts';
import type { FontBuffer } from './fonts.ts';

export type { FontBuffer } from './fonts.ts';
export { TsCoreError } from './errors.ts';

/** The Core's viewport caps (normalize.py: MAX_SIDE / MAX_PIXELS). */
export const MAX_SIDE = 4096;
export const MAX_PIXELS = 4_000_000;

export interface RenderOptions {
  /** Target width in pixels (the document viewport's width). */
  width: number;
  /** Target height in pixels (the document viewport's height). */
  height: number;
  /** Font buffers for this render; see src/fonts.ts. May be empty. */
  fonts: FontBuffer[];
  /** resvg defaultFontFamily; the spike's default is "Noto Sans". */
  defaultFontFamily?: string;
  /** resvg sansSerifFamily; the spike's default is "Noto Sans". */
  sansSerifFamily?: string;
}

export interface RenderedPng {
  png: Uint8Array;
  width: number;
  height: number;
}

const HREF_PATTERN = /(?:xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi;

function assertNoExternalReferences(source: string): void {
  for (const pattern of [HREF_PATTERN, URL_PATTERN]) {
    pattern.lastIndex = 0;
    for (let match: RegExpExecArray | null; (match = pattern.exec(source)) !== null;) {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (!value.startsWith('#')) {
        throw new TsCoreError(
          'external-reference',
          `External SVG resources are disabled: ${value.slice(0, 120)}`,
        );
      }
    }
  }
}

function assertViewportWithinCaps(width: number, height: number): void {
  if (
    !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1
    || width > MAX_SIDE || height > MAX_SIDE
    || width * height > MAX_PIXELS
  ) {
    // Message mirrors rendering.render_source in the Python Core.
    throw new TsCoreError('resource-limit', 'Viewport exceeds declared dimensions/pixel limits');
  }
}

// The wasm module is initialised once per process; every caller
// shares the same initialisation promise.
let wasmReady: Promise<void> | undefined;

function ensureWasm(): Promise<void> {
  wasmReady ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
    await initWasm(new Uint8Array(await readFile(wasmPath)));
  })();
  return wasmReady;
}

/**
 * Render an SVG source to a PNG at exactly the requested size.
 *
 * Throws TsCoreError with code 'external-reference' or
 * 'resource-limit' before rendering when the source or viewport is
 * refused, and 'render-failed' when the engine fails or produces
 * a different size than requested.
 */
export async function renderSvgToPng(source: string, options: RenderOptions): Promise<RenderedPng> {
  assertNoExternalReferences(source);
  assertViewportWithinCaps(options.width, options.height);
  await ensureWasm();
  const family = options.defaultFontFamily ?? 'Noto Sans';
  let resvg: InstanceType<typeof Resvg> | undefined;
  let image: ReturnType<InstanceType<typeof Resvg>['render']> | undefined;
  try {
    resvg = new Resvg(source, {
      fitTo: { mode: 'width', value: options.width },
      font: {
        fontBuffers: options.fonts.map((font) => font.data),
        loadSystemFonts: false,
        sansSerifFamily: options.sansSerifFamily ?? family,
        defaultFontFamily: family,
      },
      // No background: transparent, matching the Core's gate path.
    });
    image = resvg.render();
    const png = image.asPng();
    if (image.width !== options.width || image.height !== options.height) {
      throw new TsCoreError(
        'render-failed',
        `Rendered size ${image.width}x${image.height} does not match the requested `
        + `${options.width}x${options.height}; the requested size must be the document's viewport`,
      );
    }
    return { png, width: image.width, height: image.height };
  } catch (error) {
    if (error instanceof TsCoreError) throw error;
    throw new TsCoreError('render-failed', error instanceof Error ? error.message : String(error));
  } finally {
    image?.free();
    resvg?.free();
  }
}
