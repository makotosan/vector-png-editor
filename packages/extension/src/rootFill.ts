// Root-element `fill` reading and rewriting for the Preview panel's
// FILL row (Issue #45). Pure text surgery on the root start-tag only:
// the rest of the document is preserved byte-for-byte, other
// attributes keep their order and quoting, and nothing here parses
// the document into a DOM. A source whose prolog or root start-tag
// cannot be scanned with confidence reports itself unavailable
// instead of risking a corrupt rewrite.
//
// Values are handled as raw source text (no entity decoding): reading
// a value and applying it back unchanged is a byte-identical no-op.
// Values that could not appear literally in an XML attribute (angle
// brackets, a raw ampersand, control characters) are rejected by
// isValidFillValue; the writer still quote-escapes defensively.

export const MAX_FILL_VALUE_CHARS = 256;

export type RootFillState = { available: boolean; value: string };

const UNAVAILABLE: RootFillState = { available: false, value: '' };

export function isValidFillValue(value: string): boolean {
  if (value.length > MAX_FILL_VALUE_CHARS) return false;
  return !/[<>&\u0000-\u001F\u007F]/.test(value);
}

type RootAttribute = {
  name: string;
  nameStart: number; // index of the attribute name
  end: number; // index just past the closing quote
  value: string;
  quote: '"' | "'";
};

type RootTag = {
  nameEnd: number; // index just past the element name
  closeStart: number; // index of '>' or of '/' in '/>'
  attributes: RootAttribute[];
};

// Skips the XML prolog (whitespace, BOM, processing instructions,
// comments, DOCTYPE) and returns the index of the root element's '<',
// or -1 when the prolog cannot be scanned.
function rootTagStart(source: string): number {
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end === -1) return -1;
      i = end + 2;
    } else if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) return -1;
      i = end + 3;
    } else if (source.startsWith('<!DOCTYPE', i)) {
      // A DOCTYPE may carry an internal subset in brackets; the
      // declaration ends at the first '>' outside them.
      let depth = 0;
      let j = i + '<!DOCTYPE'.length;
      for (; j < source.length; j += 1) {
        if (source[j] === '[') depth += 1;
        else if (source[j] === ']') depth -= 1;
        else if (source[j] === '>' && depth <= 0) break;
      }
      if (j >= source.length) return -1;
      i = j + 1;
    } else {
      break;
    }
  }
  return source[i] === '<' ? i : -1;
}

// Scans the root start-tag. Returns null when the root is not an
// `<svg>` element or the tag is malformed (unterminated, unquoted or
// valueless attributes, a stray '/').
function scanRootTag(source: string): RootTag | null {
  const start = rootTagStart(source);
  if (start === -1) return null;
  let i = start + 1;
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(source.slice(i));
  if (!nameMatch || nameMatch[0] !== 'svg') return null;
  i += nameMatch[0].length;
  const nameEnd = i;
  const attributes: RootAttribute[] = [];
  for (;;) {
    let spaces = 0;
    while (i < source.length && /\s/.test(source[i])) { i += 1; spaces += 1; }
    if (i >= source.length) return null;
    if (source[i] === '>') return { nameEnd, closeStart: i, attributes };
    if (source[i] === '/' && source[i + 1] === '>') return { nameEnd, closeStart: i, attributes };
    if (spaces === 0) return null; // attributes must be whitespace-separated
    const attrMatch = /^[^\s=/>"'<]+/.exec(source.slice(i));
    if (!attrMatch) return null;
    const nameStart = i;
    const name = attrMatch[0];
    i += name.length;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== '=') return null;
    i += 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    const quote = source[i];
    if (quote !== '"' && quote !== "'") return null;
    const valueStart = i + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd === -1) return null;
    attributes.push({ name, nameStart, end: valueEnd + 1, value: source.slice(valueStart, valueEnd), quote });
    i = valueEnd + 1;
  }
}

// The root element's current `fill` value ('' when the attribute is
// absent), or unavailable when the root cannot be scanned.
export function readRootFill(source: string): RootFillState {
  const tag = scanRootTag(source);
  if (!tag) return UNAVAILABLE;
  const fill = tag.attributes.find((a) => a.name === 'fill');
  return { available: true, value: fill?.value ?? '' };
}

function quoteValue(value: string, preferred: '"' | "'"): string {
  if (!value.includes(preferred)) return `${preferred}${value}${preferred}`;
  const other = preferred === '"' ? "'" : '"';
  if (!value.includes(other)) return `${other}${value}${other}`;
  const escaped = value.replace(/"/g, '&quot;');
  return `"${escaped}"`;
}

// Returns the source with the root element's `fill` presentation
// attribute set to `rawValue` (an empty value removes the attribute),
// or null when the value is invalid or the root cannot be scanned.
// Only the root start-tag changes; everything else is byte-identical.
export function setRootFill(source: string, rawValue: string): string | null {
  const value = rawValue.trim();
  if (!isValidFillValue(value)) return null;
  const tag = scanRootTag(source);
  if (!tag) return null;
  const fill = tag.attributes.find((a) => a.name === 'fill');
  if (value === '') {
    if (!fill) return source;
    // Remove the attribute together with one separating whitespace
    // character before its name.
    const from = fill.nameStart > 0 && /\s/.test(source[fill.nameStart - 1]) ? fill.nameStart - 1 : fill.nameStart;
    return source.slice(0, from) + source.slice(fill.end);
  }
  const written = `fill=${quoteValue(value, fill?.quote ?? '"')}`;
  if (fill) return source.slice(0, fill.nameStart) + written + source.slice(fill.end);
  // Insert as the last attribute, just before the tag's close. When
  // whitespace already precedes the close, reuse it as the separator
  // and keep a space before the close instead of doubling up.
  const before = source.slice(0, tag.closeStart);
  const after = source.slice(tag.closeStart);
  return /\s$/.test(before) ? `${before}${written} ${after}` : `${before} ${written}${after}`;
}
