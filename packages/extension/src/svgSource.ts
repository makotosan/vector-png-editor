import { MAX_SVG_BYTES } from './profile.ts';

// Pure helpers for plain `.svg` documents (Issue #47). An SVG file is
// edited as text: its bytes are the source, decoded as UTF-8 exactly
// (BOM preserved as a leading U+FEFF, like the PNG extraction path), and
// never parsed into a DOM or inserted as markup anywhere.

export function isSvgFileName(fileName: string): boolean {
  return /\.svg$/i.test(fileName);
}

// Decodes file bytes as an editable SVG source text. Returns null when
// the bytes cannot be an editor source: over the shared source size
// limit or not valid UTF-8.
export function decodeSvgText(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_SVG_BYTES) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type SvgSize = { width: number; height: number };

// Fallback viewport when the root declares no usable dimensions; it
// matches the Core's default validate/build viewport.
export const DEFAULT_SVG_SIZE: SvgSize = { width: 1024, height: 1024 };

const MAX_DIMENSION = 4096;
const MAX_PIXELS = 4_000_000;

// Attributes of the first `<svg ...>` root tag, or null when the source
// has no SVG root. This is a bounded text scan of the root tag only -
// the same "text, never DOM" stance as the advisory diagnostics.
export function svgRootAttributes(source: string): Map<string, string> | null {
  const start = source.search(/<svg(?=[\s/>])/);
  if (start === -1) return null;
  const end = source.indexOf('>', start);
  if (end === -1) return null;
  const tag = source.slice(start + 4, end);
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(pattern)) {
    if (!attributes.has(match[1])) attributes.set(match[1], match[2] ?? match[3] ?? '');
  }
  return attributes;
}

export function hasSvgRoot(source: string): boolean {
  return svgRootAttributes(source) !== null;
}

// A plain user-unit length ("640", "640.5", "640px"); percentages and
// font-relative units are not absolute sizes and are ignored.
function parseLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(value.trim());
  if (!match) return undefined;
  const length = Number(match[1]);
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

function clampSize(width: number, height: number): SvgSize {
  let w = Math.max(1, Math.round(width));
  let h = Math.max(1, Math.round(height));
  w = Math.min(w, MAX_DIMENSION);
  h = Math.min(h, MAX_DIMENSION);
  if (w * h > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
  }
  return { width: w, height: h };
}

// The document's pixel size: the root's width/height attributes win,
// then the viewBox (a lone width or height is completed through the
// viewBox aspect ratio), then the default viewport. Returns null only
// when the source has no `<svg>` root at all.
export function parseSvgSize(source: string): SvgSize | null {
  const attributes = svgRootAttributes(source);
  if (!attributes) return null;
  let width = parseLength(attributes.get('width'));
  let height = parseLength(attributes.get('height'));
  const viewBox = attributes.get('viewBox')
    ?.trim().split(/[\s,]+/).map(Number);
  const boxWidth = viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) ? viewBox[2] : undefined;
  const boxHeight = viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) ? viewBox[3] : undefined;
  if ((width === undefined || height === undefined) && boxWidth && boxHeight && boxWidth > 0 && boxHeight > 0) {
    if (width === undefined && height === undefined) {
      width = boxWidth;
      height = boxHeight;
    } else if (width === undefined) {
      width = (height as number) * (boxWidth / boxHeight);
    } else {
      height = width * (boxHeight / boxWidth);
    }
  }
  return clampSize(width ?? DEFAULT_SVG_SIZE.width, height ?? DEFAULT_SVG_SIZE.height);
}

export function svgDocumentSize(source: string): SvgSize {
  return parseSvgSize(source) ?? { ...DEFAULT_SVG_SIZE };
}
