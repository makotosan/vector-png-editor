// svg-normalization-v1 normalizer (Issue #59): the TypeScript
// port of the Python Core's normalize.py, behavior for behavior.
//
// The pipeline mirrors the profile structure the Core implements:
// input inspection (section 2), a hand-written tokenizer/parser
// for the closed CSS subset (section 3, with the spec
// amendments: letter-spacing per G1, quoted and leading-hyphen
// font-family names per G3), restricted arrow-marker expansion
// (section 3.1, with G2 curved C-segment hosts whose tangent is
// endpoint minus second control point), cascade/inheritance
// resolution materializing winning declarations as presentation
// attributes (section 4), accessibility migration with its
// recorded losses (section 5), the before/after rendering gate
// (section 6), and the section 7 conversion report with its
// failure codes.
//
// The output is byte-identical to the Python normalizer's for
// the same input: the transformation is deterministic source
// rewriting over the ElementTree-shaped DOM in src/dom.ts
// (attribute insertion order, ElementTree serialization), and
// the few numbers the transform formats itself (the marker
// placement transform) use Python's %g formatting, reproduced
// in gFormat below.
//
// The render gate runs on this package's resvg renderer with the
// SAME font set for the before and after renders and requires
// exact decoded-RGBA equality of the two renders within this
// engine, exactly as the Core's gate requires it within Cairo.
// Cross-engine pixel comparison is meaningless and is never
// attempted here.
//
// One deliberate renderer divergence is recorded, not hidden:
// resvg does not paint markers on stroke="none" hosts while
// CairoSVG does (Issue #57 spike). The transformation mirrors
// the Python normalizer exactly — markers on such hosts are
// expanded like any other, never rewritten to suit one
// renderer — so for that input class the TS gate reports
// render-mismatch where the Python gate passes. The gate stays
// self-consistent (before and after are both resvg renders);
// the parent Issue #61 tracks the conformance record. See
// tests/normalize.test.mjs for the targeted case.
import { createHash } from 'node:crypto';
import {
  DomElement, NormalizeFailure, SVG_NS, deepClone, iterElements,
  iterText, parseNormalizeTree, preflightNormalize, serializeDom,
  svgLocal,
} from './dom.ts';
import { TsCoreError } from './errors.ts';
import type { FontBuffer } from './fonts.ts';
import { decodePngRgba, rgbaEqual } from './pngPixels.ts';
import { renderSvgToPng } from './render.ts';
import { ATTRS, TAGS, validateSource } from './validate.ts';

export { NormalizeFailure } from './dom.ts';

export const PROFILE = 'svg-normalization-v1';
const MAX_BYTES = 1_000_000;
const MAX_CSS_BYTES = 100_000;
const MAX_SELECTORS = 1000;
const MAX_DECLARATIONS = 10_000;
const MAX_SIDE = 4096;
const MAX_PIXELS = 4_000_000;
const MAX_PNG = 32_000_000;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ENUMS: Record<string, string[]> = {
  'fill-rule': 'nonzero evenodd'.split(' '),
  'stroke-linecap': 'butt round square'.split(' '),
  'stroke-linejoin': 'miter round bevel'.split(' '),
  'font-weight': 'normal bold 100 200 300 400 500 600 700 800 900'.split(' '),
  'font-style': 'normal italic oblique'.split(' '),
  'text-anchor': 'start middle end'.split(' '),
  'dominant-baseline':
    'auto alphabetic middle central hanging text-before-edge text-after-edge'.split(' '),
};
const PROPS = new Set([
  ...Object.keys(ENUMS),
  ...('fill stroke stop-color opacity fill-opacity stroke-opacity stop-opacity '
    + 'stroke-width font-size stroke-miterlimit stroke-dashoffset stroke-dasharray '
    + 'font-family clip-path rx ry marker-end letter-spacing').split(' '),
]);
const INHERITED = new Set(
  [...PROPS].filter(
    (prop) =>
      !['opacity', 'clip-path', 'stop-color', 'stop-opacity', 'rx', 'ry'].includes(prop),
  ),
);
const NUMBER_SRC = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)';
const NUMBER_RE = new RegExp(`^${NUMBER_SRC}$`);
const IDENT_FULL = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SVG_ID_FULL = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const FRAGMENT = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/;
const COLORS = new Set(
  'black silver gray white maroon red purple fuchsia green lime olive yellow navy blue teal aqua'.split(' '),
);

// ------------------------------------------------------------------
// Python string/number semantics the transform depends on.
// ------------------------------------------------------------------

/** Python's whitespace set (str.isspace / split / strip). */
const PY_WS_CHARS =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\u001c-\\u001f';
const PY_WS_RUN = new RegExp(`[${PY_WS_CHARS}]+`);
const PY_WS_EDGE = new RegExp(`^[${PY_WS_CHARS}]+|[${PY_WS_CHARS}]+$`, 'g');
const PY_WS_SINGLE = new RegExp(`^[${PY_WS_CHARS}]$`);

function isPySpace(ch: string): boolean {
  return PY_WS_SINGLE.test(ch);
}

/** " ".join(text.split()): Python's whitespace-normalizing split/join. */
function pySplitWords(text: string): string[] {
  return text.split(PY_WS_RUN).filter((part) => part !== '');
}

function pyStrip(text: string): string {
  return text.replace(PY_WS_EDGE, '');
}

/** Python repr() of a string, as embedded in failure messages. */
export function pyRepr(text: string): string {
  const quote = !text.includes("'") || text.includes('"') ? "'" : '"';
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (isPyPrintable(ch)) out += ch;
    else if (cp < 0x100) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += `\\U${cp.toString(16).padStart(8, '0')}`;
  }
  return out + quote;
}

function isPyPrintable(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp === 0x20) return true;
  // Python's str.isprintable: everything except separator (other
  // than ASCII space) and "other" categories is printable.
  return !/[\p{C}\p{Z}]/u.test(ch);
}

/**
 * Python's format(value, "g"): six significant digits, trailing
 * zeros removed, scientific notation below 1e-4 and at 1e6 and
 * above, with round-half-to-even applied to the exact binary
 * value at a decimal tie (decided on a 25-digit expansion, far
 * past the precision of any input this formats).
 */
export function gFormat(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const sign = value < 0 ? '-' : '';
  const match = /^([0-9])\.([0-9]+)e([+-][0-9]+)$/.exec(
    Math.abs(value).toExponential(24),
  )!;
  const digits = match[1] + match[2];
  let exponent = parseInt(match[3], 10);
  const head = digits.slice(0, 6);
  const rest = digits.slice(6);
  const threshold = `5${'0'.repeat(rest.length - 1)}`;
  let rounded = head;
  const roundUp =
    rest > threshold ||
    (rest === threshold && parseInt(head[5], 10) % 2 === 1);
  if (roundUp) {
    const bumped = parseInt(head, 10) + 1;
    if (bumped === 1_000_000) {
      rounded = '100000';
      exponent += 1;
    } else {
      rounded = String(bumped).padStart(6, '0');
    }
  }
  const significant = rounded.replace(/0+$/, '') || '0';
  if (exponent < -4 || exponent >= 6) {
    const mantissa =
      significant.length > 1
        ? `${significant[0]}.${significant.slice(1)}`
        : significant;
    const expText = `${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
    return `${sign}${mantissa}e${expText}`;
  }
  if (exponent >= 0) {
    if (significant.length > exponent + 1) {
      return `${sign}${significant.slice(0, exponent + 1)}.${significant.slice(exponent + 1)}`;
    }
    return `${sign}${significant}${'0'.repeat(exponent + 1 - significant.length)}`;
  }
  return `${sign}0.${'0'.repeat(-exponent - 1)}${significant}`;
}

/** Python float() for the viewBox path of the viewport fallback. */
function pyFloat(text: string): number | null {
  const trimmed = text.trim();
  const special = /^[+-]?(inf(inity)?|nan)$/i.exec(trimmed);
  if (special) {
    if (/nan/i.test(special[1])) return NaN;
    return trimmed.startsWith('-') ? -Infinity : Infinity;
  }
  const grammar =
    /^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
  if (!grammar.test(trimmed)) return null;
  return parseFloat(trimmed.replaceAll('_', ''));
}

/** Python int(round(x)): round-half-to-even on the exact value. */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function fail(code: string, stage: string, message: string): never {
  throw new NormalizeFailure(code, stage, message);
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ------------------------------------------------------------------
// CSS values (profile section 3)
// ------------------------------------------------------------------

function scalar(
  value: string,
  minimum?: number,
  maximum?: number,
  px = false,
): number {
  const pattern = new RegExp(`^${NUMBER_SRC}${px ? '(?:px)?' : ''}$`);
  if (!pattern.test(value) || [...value].length > 128) {
    fail('unsupported-css', 'css', `Unsupported numeric syntax: ${pyRepr(value)}`);
  }
  const number = parseFloat(value.endsWith('px') ? value.slice(0, -2) : value);
  if (
    !Number.isFinite(number) ||
    (minimum !== undefined && number < minimum) ||
    (maximum !== undefined && number > maximum)
  ) {
    fail('unsupported-css', 'css', `Numeric value out of range: ${pyRepr(value)}`);
  }
  return number;
}

const FORBIDDEN_VALUE_CHARS = '\\@{};<>\x00';

function cssValue(prop: string, raw: string): string {
  const val = pyStrip(raw);
  const low = val.toLowerCase();
  if (
    !PROPS.has(prop) ||
    [...val].some((ch) => FORBIDDEN_VALUE_CHARS.includes(ch))
  ) {
    fail('unsupported-css', 'css', `Unsupported property or value: ${prop}`);
  }
  if (prop === 'fill' || prop === 'stroke' || prop === 'stop-color') {
    if (COLORS.has(low) || /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(val)) {
      return low;
    }
    if (prop !== 'stop-color' && (low === 'none' || FRAGMENT.test(val))) {
      return val.startsWith('url(') ? val : low;
    }
    fail('unsupported-css', 'css', `Unsupported paint value for ${prop}: ${pyRepr(val)}`);
  } else if (prop === 'clip-path' || prop === 'marker-end') {
    if (low === 'none' || FRAGMENT.test(val)) {
      return val.startsWith('url(') ? val : low;
    }
    fail('unsupported-css', 'css', `Only none or a local url(#id) is supported for ${prop}`);
  } else if (prop in ENUMS) {
    if (!ENUMS[prop].includes(low)) {
      fail('unsupported-css', 'css', `Unsupported ${prop} value: ${pyRepr(val)}`);
    }
    return low;
  } else if (prop.endsWith('opacity')) {
    scalar(low, 0, 1);
  } else if (['stroke-width', 'font-size', 'rx', 'ry'].includes(prop)) {
    scalar(low, 0, undefined, true);
  } else if (prop === 'letter-spacing') {
    // Amendment G1: a signed decimal, optionally px; the keyword
    // `normal` is not accepted.
    scalar(low, undefined, undefined, true);
  } else if (prop === 'stroke-miterlimit') {
    scalar(low, 1);
  } else if (prop === 'stroke-dashoffset') {
    scalar(low, undefined, undefined, true);
  } else if (prop === 'stroke-dasharray') {
    if (low !== 'none') {
      const num = `${NUMBER_SRC}(?:px)?`;
      const pattern = new RegExp(
        `^${num}(?:(?:[${PY_WS_CHARS}]*,[${PY_WS_CHARS}]*|[${PY_WS_CHARS}]+)${num})*$`,
      );
      if (!pattern.test(low)) {
        fail('unsupported-css', 'css', `Unsupported stroke-dasharray value: ${pyRepr(val)}`);
      }
      const parts = low.split(new RegExp(`[${PY_WS_CHARS},]+`)).filter((p) => p !== '');
      if (!parts.some((part) => scalar(part, 0, undefined, true) !== 0)) {
        fail('unsupported-css', 'css', 'stroke-dasharray must not be all zero');
      }
    }
  } else if (prop === 'font-family') {
    // Unquoted word sequences (a leading hyphen is a valid CSS
    // identifier start: -apple-system) and quoted names with
    // printable-ASCII content; escapes are rejected.
    const name =
      `(?:-?[A-Za-z_][A-Za-z0-9_-]*(?: +-?[A-Za-z_][A-Za-z0-9_-]*)*`
      + `|"[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]+"`
      + `|'[\\x20-\\x26\\x28-\\x5b\\x5d-\\x7e]+')`;
    const pattern = new RegExp(
      `^${name}(?:[${PY_WS_CHARS}]*,[${PY_WS_CHARS}]*${name})*$`,
    );
    if (!pattern.test(val)) {
      fail('unsupported-css', 'css', `Unsupported font-family value: ${pyRepr(val)}`);
    }
    return val;
  }
  return low;
}

// ------------------------------------------------------------------
// CSS tokenizer/parser (profile section 3)
// ------------------------------------------------------------------

const WORD_TOKENS = new Set(['ident', 'number', 'hash', 'string', 'url']);

interface Tok {
  type: string;
  value: string;
}

function isPyDigit(ch: string): boolean {
  return /[\p{Nd}\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/u.test(ch);
}

function isPyAlpha(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

function checkedCss(text: string): string {
  const chars = Array.from(text);
  const stack: string[] = [];
  let quote: string | null = null;
  let index = 0;
  const closing: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  while (index < chars.length) {
    const ch = chars[index];
    if (ch === '\\') {
      fail('unsupported-css', 'css', 'CSS escapes are not supported');
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (chars[index] === '/' && chars[index + 1] === '*') {
      let end = -1;
      for (let j = index + 2; j + 1 < chars.length + 1; j++) {
        if (chars[j] === '*' && chars[j + 1] === '/') {
          end = j;
          break;
        }
      }
      if (end < 0) fail('unsupported-css', 'css', 'Unclosed CSS comment');
      index = end + 1;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '{' || ch === '(' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ')' || ch === ']') {
      if (stack.length === 0 || stack.pop() !== closing[ch]) {
        fail('unsupported-css', 'css', 'Unbalanced CSS');
      }
    }
    index += 1;
  }
  if (stack.length > 0 || quote !== null) {
    fail('unsupported-css', 'css', 'Unclosed CSS block or string');
  }
  return text;
}

function tokenizeCss(text: string): Tok[] {
  const chars = Array.from(text);
  const tokens: Tok[] = [];
  const rest = (from: number): string => chars.slice(from).join('');
  let i = 0;
  const n = chars.length;
  while (i < n) {
    const ch = chars[i];
    if (isPySpace(ch)) {
      i += 1;
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '*') {
      let end = -1;
      for (let j = i + 2; j + 1 < n + 1; j++) {
        if (chars[j] === '*' && chars[j + 1] === '/') {
          end = j;
          break;
        }
      }
      if (end < 0) fail('unsupported-css', 'css', 'Unclosed CSS comment');
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let end = -1;
      for (let j = i + 1; j < n; j++) {
        if (chars[j] === ch) {
          end = j;
          break;
        }
      }
      if (end < 0 || chars.slice(i + 1, end).includes('\n')) {
        fail('unsupported-css', 'css', 'Unclosed CSS string');
      }
      tokens.push({ type: 'string', value: chars.slice(i, end + 1).join('') });
      i = end + 1;
      continue;
    }
    if (ch === '#') {
      const match = /^[A-Za-z0-9_-]+/.exec(rest(i + 1));
      if (!match) fail('unsupported-css', 'css', 'Malformed hash token');
      tokens.push({ type: 'hash', value: `#${match[0]}` });
      i += 1 + match[0].length;
      continue;
    }
    if (ch === '@') {
      const match = /^[A-Za-z0-9_-]+/.exec(rest(i + 1));
      tokens.push({ type: 'at', value: `@${match ? match[0] : ''}` });
      i += 1 + (match ? match[0].length : 0);
      continue;
    }
    if (
      isPyDigit(ch) ||
      ((ch === '+' || ch === '-' || ch === '.') &&
        i + 1 < n &&
        (isPyDigit(chars[i + 1]) || chars[i + 1] === '.'))
    ) {
      const match = new RegExp(`^${NUMBER_SRC}(?:[A-Za-z%]+)?`).exec(rest(i));
      if (!match) fail('unsupported-css', 'css', 'Malformed number token');
      tokens.push({ type: 'number', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (isPyAlpha(ch) || ch === '_' || ch === '-' || ch.codePointAt(0)! > 127) {
      const match = /^-?[A-Za-z_][A-Za-z0-9_-]*/.exec(rest(i));
      if (!match) fail('unsupported-css', 'css', 'Malformed identifier token');
      const name = match[0];
      const j = i + name.length;
      if (j < n && chars[j] === '(') {
        if (name.toLowerCase() === 'url') {
          let k = j + 1;
          while (k < n && isPySpace(chars[k])) k += 1;
          let inner: string;
          if (k < n && (chars[k] === "'" || chars[k] === '"')) {
            let end = -1;
            for (let m = k + 1; m < n; m++) {
              if (chars[m] === chars[k]) {
                end = m;
                break;
              }
            }
            if (end < 0) fail('unsupported-css', 'css', 'Unclosed url string');
            inner = chars.slice(k, end + 1).join('');
            k = end + 1;
          } else {
            let end = -1;
            for (let m = k; m < n; m++) {
              if (chars[m] === ')') {
                end = m;
                break;
              }
            }
            if (end < 0) fail('unsupported-css', 'css', 'Unclosed url()');
            inner = pyStrip(chars.slice(k, end).join(''));
            k = end;
          }
          while (k < n && isPySpace(chars[k])) k += 1;
          if (k >= n || chars[k] !== ')') {
            fail('unsupported-css', 'css', 'Malformed url()');
          }
          tokens.push({ type: 'url', value: `url(${inner})` });
          i = k + 1;
          continue;
        }
        tokens.push({ type: 'function', value: `${name}(` });
        i = j + 1;
        continue;
      }
      tokens.push({ type: 'ident', value: name });
      i = j;
      continue;
    }
    tokens.push({ type: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

function serializeValue(tokens: Tok[]): string {
  let out = '';
  let prevWord = false;
  for (const tok of tokens) {
    const word = WORD_TOKENS.has(tok.type);
    if (out !== '' && word && prevWord) out += ' ';
    out += tok.value;
    prevWord = word;
  }
  return out;
}

class Budget {
  selectors = 0;
  declarations = 0;

  addDeclaration(): void {
    this.declarations += 1;
    if (this.declarations > MAX_DECLARATIONS) {
      fail('resource-limit', 'css', 'More than 10,000 CSS declarations');
    }
  }

  addSelectors(count: number): void {
    this.selectors += count;
    if (this.selectors > MAX_SELECTORS) {
      fail('resource-limit', 'css', 'More than 1,000 CSS selectors');
    }
  }
}

function parseDeclarations(tokens: Tok[], budget: Budget): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  let i = 0;
  const n = tokens.length;
  while (i < n) {
    if (tokens[i].type === 'punct' && tokens[i].value === ';') {
      i += 1;
      continue;
    }
    if (tokens[i].type !== 'ident') {
      fail('unsupported-css', 'css', 'Declaration must start with a property name');
    }
    const prop = tokens[i].value.toLowerCase();
    i += 1;
    if (i >= n || tokens[i].type !== 'punct' || tokens[i].value !== ':') {
      fail('unsupported-css', 'css', `Declaration for ${pyRepr(prop)} is missing ':'`);
    }
    i += 1;
    const valueTokens: Tok[] = [];
    let depth = 0;
    while (i < n) {
      const tok = tokens[i];
      if (tok.type === 'punct' && tok.value === ';' && depth === 0) break;
      if (tok.type === 'function' || (tok.type === 'punct' && tok.value === '(')) {
        depth += 1;
      } else if (tok.type === 'punct' && tok.value === ')') {
        depth -= 1;
        if (depth < 0) {
          fail('unsupported-css', 'css', 'Unbalanced parenthesis in value');
        }
      }
      valueTokens.push(tok);
      i += 1;
    }
    if (i < n) i += 1; // consume ';'
    if (depth !== 0) {
      fail('unsupported-css', 'css', 'Unbalanced parenthesis in value');
    }
    for (let j = 0; j < valueTokens.length; j++) {
      const tok = valueTokens[j];
      if (
        tok.type === 'punct' && tok.value === '!' &&
        j + 1 < valueTokens.length &&
        valueTokens[j + 1].type === 'ident' &&
        valueTokens[j + 1].value.toLowerCase() === 'important'
      ) {
        fail('unsupported-css', 'css', '!important is not supported');
      }
    }
    budget.addDeclaration();
    result.push([prop, cssValue(prop, serializeValue(valueTokens))]);
  }
  return result;
}

type CssRule = [string[], Array<[string, string]>];

function parseStylesheet(text: string, budget: Budget): CssRule[] {
  const tokens = tokenizeCss(checkedCss(text));
  const rules: CssRule[] = [];
  let i = 0;
  const n = tokens.length;
  while (i < n) {
    if (tokens[i].type === 'at') {
      fail('unsupported-css', 'css', 'At-rules are not supported');
    }
    const prelude: Tok[] = [];
    while (i < n && !(tokens[i].type === 'punct' && tokens[i].value === '{')) {
      if (tokens[i].type === 'punct' && (tokens[i].value === '}' || tokens[i].value === ';')) {
        fail('unsupported-css', 'css', 'Malformed rule prelude');
      }
      prelude.push(tokens[i]);
      i += 1;
    }
    if (i >= n) fail('unsupported-css', 'css', 'Rule is missing its block');
    i += 1; // consume '{'
    const groups: Tok[][] = [[]];
    for (const tok of prelude) {
      if (tok.type === 'punct' && tok.value === ',') groups.push([]);
      else groups[groups.length - 1].push(tok);
    }
    const selectors: string[] = [];
    for (const group of groups) {
      if (group.length === 1 && group[0].type === 'ident') {
        const selector = group[0].value;
        if (!TAGS.has(selector) && selector !== 'marker') {
          fail('unsupported-css', 'css', `Unsupported element selector: ${selector}`);
        }
        selectors.push(selector);
      } else if (
        group.length === 2 &&
        group[0].type === 'punct' && group[0].value === '.' &&
        group[1].type === 'ident' && IDENT_FULL.test(group[1].value)
      ) {
        selectors.push(`.${group[1].value}`);
      } else if (
        group.length === 1 && group[0].type === 'hash' &&
        IDENT_FULL.test(group[0].value.slice(1))
      ) {
        selectors.push(group[0].value);
      } else {
        fail(
          'unsupported-css', 'css',
          'Unsupported selector (only element, .class and #id are allowed)',
        );
      }
    }
    budget.addSelectors(selectors.length);
    const block: Tok[] = [];
    let depth = 1;
    while (i < n && depth > 0) {
      const tok = tokens[i];
      if (tok.type === 'punct' && tok.value === '{') {
        depth += 1;
      } else if (tok.type === 'punct' && tok.value === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      block.push(tok);
      i += 1;
    }
    if (depth > 0) fail('unsupported-css', 'css', 'Unclosed rule block');
    rules.push([selectors, parseDeclarations(block, budget)]);
  }
  return rules;
}

function matchesSelector(selector: string, node: DomElement): boolean {
  if (selector.startsWith('.')) {
    return pySplitWords(node.get('class') ?? '').includes(selector.slice(1));
  }
  if (selector.startsWith('#')) return node.get('id') === selector.slice(1);
  return svgLocal(node.tag) === selector;
}

function specificity(selector: string): [number, number, number] {
  return [
    selector.startsWith('#') ? 1 : 0,
    selector.startsWith('.') ? 1 : 0,
    selector[0] !== '.' && selector[0] !== '#' ? 1 : 0,
  ];
}

type Rank = [number, number, number, number];

function compareRank(a: Rank, b: Rank): number {
  for (let k = 0; k < 4; k++) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return 0;
}

// ------------------------------------------------------------------
// Input inspection (profile section 2)
// ------------------------------------------------------------------

interface Inspection {
  ids: Map<string, DomElement>;
  locations: Map<DomElement, string>;
  parent: Map<DomElement, DomElement>;
}

const ARIA_ATTRIBUTE = /^aria-[a-z][a-z-]*$/;
const RESOURCE_DEFINITIONS = new Set(['linearGradient', 'radialGradient', 'clipPath', 'marker']);

function hasForbiddenAttrSyntax(value: string): boolean {
  for (const ch of value) {
    if (FORBIDDEN_VALUE_CHARS.includes(ch)) return true;
    const cp = ch.codePointAt(0)!;
    if (cp < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r') return true;
  }
  return false;
}

function inspectTree(root: DomElement): Inspection {
  const ids = new Map<string, DomElement>();
  const locations = new Map<DomElement, string>();
  const parent = new Map<DomElement, DomElement>();
  let cssBytes = 0;

  const visit = (node: DomElement, path: string): void => {
    locations.set(node, path);
    const tag = svgLocal(node.tag);
    const allowed = new Set(TAGS);
    allowed.add('style');
    allowed.add('marker');
    if (!node.tag.startsWith(`{${SVG_NS}}`) || !allowed.has(tag)) {
      fail('unsafe-input', 'input', `Unsupported element: ${tag}`);
    }
    if (tag === 'svg' && node !== root) {
      fail('unsafe-input', 'input', 'Nested SVG roots are unsupported');
    }
    if (tag === 'style') {
      const owner = parent.get(node);
      const placed =
        owner === root ||
        (owner !== undefined &&
          svgLocal(owner.tag) === 'defs' &&
          parent.get(owner) === root);
      if (!placed || node.children.length > 0) {
        fail(
          'unsupported-css', 'css',
          'Style element must be a direct child of the root or of a root-level defs and contain only CSS text',
        );
      }
      const attrsOk =
        [...node.attrib.keys()].every((key) => key === 'type') &&
        (node.get('type') ?? 'text/css') === 'text/css';
      if (!attrsOk) {
        fail('unsupported-css', 'css', 'Style element attributes are unsupported');
      }
      cssBytes += utf8Bytes(node.text ?? '');
    } else {
      const extra = new Set(['class', 'style', 'role', 'marker-end']);
      if (tag === 'marker') {
        for (const key of ['markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits']) {
          extra.add(key);
        }
      }
      for (const [key, val] of node.attrib) {
        if (
          !ATTRS.has(key) && !extra.has(key) && !ARIA_ATTRIBUTE.test(key)
        ) {
          fail('unsafe-input', 'input', `Unsupported attribute: ${key}`);
        }
        if (key === 'style') {
          cssBytes += utf8Bytes(val);
        } else if (key === 'class') {
          const tokens = pySplitWords(val);
          if (
            tokens.length === 0 ||
            tokens.some((token) => !IDENT_FULL.test(token))
          ) {
            fail('unsupported-css', 'css', `Invalid class token in ${pyRepr(val)}`);
          }
        } else if (key !== 'role' && !key.startsWith('aria-')) {
          if (hasForbiddenAttrSyntax(val)) {
            fail('unsafe-input', 'input', `Unsupported attribute syntax in ${key}`);
          }
          if (PROPS.has(key)) {
            cssValue(key, val);
          } else if (val.toLowerCase().includes('url')) {
            fail('unsafe-input', 'input', `Unsupported resource syntax in ${key}`);
          }
        }
        if (key === 'id') {
          if (!SVG_ID_FULL.test(val) || ids.has(val)) {
            fail('invalid-reference', 'input', `Invalid or duplicate id: ${val}`);
          }
          ids.set(val, node);
        }
      }
    }
    const counts = new Map<string, number>();
    for (const child of node.children) {
      const name = svgLocal(child.tag);
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      parent.set(child, node);
      visit(child, `${path}/${name}[${count}]`);
    }
  };
  visit(root, '/svg[1]');
  if (cssBytes > MAX_CSS_BYTES) {
    fail(
      'resource-limit', 'input',
      'CSS exceeds 100,000 bytes across style elements and attributes',
    );
  }
  return { ids, locations, parent };
}

function referenceKinds(prop: string): Set<string> {
  if (prop === 'marker-end') return new Set(['marker']);
  if (prop === 'clip-path') return new Set(['clipPath']);
  return new Set(['linearGradient', 'radialGradient']);
}

function checkRefTarget(
  prop: string,
  val: string,
  ids: Map<string, DomElement>,
): void {
  if (!val.startsWith('url(')) return;
  const target = ids.get(val.slice(5, -1));
  if (target === undefined || !referenceKinds(prop).has(svgLocal(target.tag))) {
    fail(
      'invalid-reference', 'references',
      `Reference from ${prop} does not resolve to a supported target: ${val}`,
    );
  }
}

function checkRef(
  prop: string,
  val: string,
  ids: Map<string, DomElement>,
  node: DomElement,
  parent: Map<DomElement, DomElement>,
): void {
  checkRefTarget(prop, val, ids);
  if (!val.startsWith('url(')) return;
  let current: DomElement | undefined = node;
  while (current !== undefined) {
    if (RESOURCE_DEFINITIONS.has(svgLocal(current.tag))) {
      fail(
        'invalid-reference', 'references',
        `Reference inside a resource definition: ${val}`,
      );
    }
    current = parent.get(current);
  }
}

// ------------------------------------------------------------------
// Markers (profile section 3.1)
// ------------------------------------------------------------------

function pathPoints(d: string): { points: Array<[number, number]>; tangent: [number, number] } {
  const tokens = d.match(new RegExp(`[MLHVC]|${NUMBER_SRC}`, 'g')) ?? [];
  const stripSeparators = (text: string): string =>
    text.replace(new RegExp(`[${PY_WS_CHARS},]`, 'g'), '');
  if (stripSeparators(tokens.join('')) !== stripSeparators(d)) {
    fail(
      'unsupported-css', 'markers',
      'Marker host path may use only absolute M/L/H/V/C segments',
    );
  }
  const points: Array<[number, number]> = [];
  let index = 0;
  let command: string | null = null;
  let tangent: [number, number] | null = null;
  while (index < tokens.length) {
    if (['M', 'L', 'H', 'V', 'C'].includes(tokens[index])) {
      command = tokens[index];
      index += 1;
    }
    const count = command === 'C' ? 6 : command === 'M' || command === 'L' ? 2 : 1;
    if (
      command === null ||
      index + count > tokens.length ||
      tokens.slice(index, index + count).some((t) => ['M', 'L', 'H', 'V', 'C'].includes(t))
    ) {
      fail('unsupported-css', 'markers', 'Malformed marker host path');
    }
    const coords = tokens.slice(index, index + count).map((t) => scalar(t));
    index += count;
    if (command === 'C') {
      if (points.length === 0) {
        fail('unsupported-css', 'markers', 'Marker host path must start with a point');
      }
      const end: [number, number] = [coords[4], coords[5]];
      tangent = [end[0] - coords[2], end[1] - coords[3]];
      if (tangent[0] === 0 && tangent[1] === 0) {
        tangent = [end[0] - coords[0], end[1] - coords[1]];
      }
      points.push(end);
      continue;
    }
    let point: [number, number];
    if (command === 'H' || command === 'V') {
      if (points.length === 0) {
        fail('unsupported-css', 'markers', 'Marker host path must start with a point');
      }
      const last = points[points.length - 1];
      point = command === 'H' ? [coords[0], last[1]] : [last[0], coords[0]];
    } else {
      if (command === 'M' && points.length > 0) {
        fail('unsupported-css', 'markers', 'Marker host path must be a single subpath');
      }
      point = [coords[0], coords[1]];
    }
    if (points.length > 0) {
      const last = points[points.length - 1];
      tangent = [point[0] - last[0], point[1] - last[1]];
    }
    points.push(point);
    if (command === 'M') command = 'L';
  }
  if (
    points.length < 2 || tangent === null ||
    (tangent[0] === 0 && tangent[1] === 0)
  ) {
    fail('unsupported-css', 'markers', 'Marker host path has a degenerate last segment');
  }
  return { points, tangent };
}

interface MarkerDefinition {
  refX: number;
  refY: number;
  child: DomElement;
  paint: string;
  unit: string;
}

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

function markerDefinition(
  src: DomElement,
  parent: Map<DomElement, DomElement>,
  computed: Map<DomElement, Map<string, string>>,
): MarkerDefinition {
  const owner = parent.get(src);
  const ownerParent = owner !== undefined ? parent.get(owner) : undefined;
  if (
    owner === undefined || svgLocal(owner.tag) !== 'defs' ||
    ownerParent === undefined || svgLocal(ownerParent.tag) !== 'svg' ||
    parent.get(ownerParent) !== undefined
  ) {
    fail('unsupported-css', 'markers', 'Markers must be direct children of a root-level defs');
  }
  const allowed = new Set(['id', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits']);
  if (
    [...src.attrib.keys()].some((key) => !allowed.has(key)) ||
    src.get('orient') !== 'auto' ||
    src.children.length !== 1 ||
    svgLocal(src.children[0].tag) !== 'path'
  ) {
    fail('unsupported-css', 'markers', 'Marker definition is outside the restricted subset');
  }
  const w = scalar(src.get('markerWidth') ?? '', 0);
  const h = scalar(src.get('markerHeight') ?? '', 0);
  if (w <= 0 || h <= 0) {
    fail('unsupported-css', 'markers', 'Marker width/height must be positive');
  }
  const refX = scalar(src.get('refX') ?? '0', 0, w);
  const refY = scalar(src.get('refY') ?? '0', 0, h);
  const child = src.children[0];
  // The closepath command is case-insensitive in SVG (z == Z); the
  // triangle geometry itself remains exact.
  const ws = `[${PY_WS_CHARS}]`;
  const triangle = new RegExp(
    `^M${ws}*0${ws}*,?${ws}*0${ws}+L${ws}*${escapeRegExpLiteral(gFormat(w))}${ws}*,?${ws}*${escapeRegExpLiteral(gFormat(h / 2))}${ws}+L${ws}*0${ws}*,?${ws}*${escapeRegExpLiteral(gFormat(h))}${ws}*[Zz]$`,
  );
  if (
    [...child.attrib.keys()].some((key) => key !== 'd' && key !== 'fill') ||
    !triangle.test(child.get('d') ?? '')
  ) {
    fail(
      'unsupported-css', 'markers',
      'Only the viewport-contained triangle marker geometry is supported',
    );
  }
  const paint = computed.get(child)?.get('fill') ?? 'black';
  if (paint.startsWith('url(') || paint === 'none') {
    fail('unsupported-css', 'markers', 'Marker paint must be a solid color');
  }
  const unit = src.get('markerUnits') ?? 'strokeWidth';
  if (unit !== 'strokeWidth' && unit !== 'userSpaceOnUse') {
    fail('unsupported-css', 'markers', `Unsupported markerUnits: ${unit}`);
  }
  return { refX, refY, child, paint, unit };
}

/**
 * Section 3.1 marker expansion: replace each host's marker-end
 * with the expanded clone group, in place (the host's marker-end
 * attribute is consumed for every element, expanded or not).
 * Shared by the transformation and by the render gate's input
 * accommodation (see gateInputText): both run this same code
 * path, including the G2 curved-host tangent rule, so markers
 * expand identically wherever they are expanded. Returns the
 * number of markers expanded.
 */
function expandMarkers(
  root: DomElement,
  ids: Map<string, DomElement>,
  parent: Map<DomElement, DomElement>,
  computed: Map<DomElement, Map<string, string>>,
  markers: Map<DomElement, MarkerDefinition>,
): number {
  let expanded = 0;
  for (const node of [...iterElements(root)]) {
    const marker = computed.get(node)?.get('marker-end') ?? 'none';
    node.attrib.delete('marker-end');
    if (marker === 'none') continue;
    if (
      svgLocal(node.tag) !== 'path' ||
      (computed.get(node)?.get('fill') ?? 'black') !== 'none'
    ) {
      fail(
        'unsupported-css', 'markers',
        'marker-end hosts must be paths with fill none',
      );
    }
    const src = ids.get(marker.slice(5, -1))!;
    const definition = markers.get(src)!;
    const scale =
      definition.unit === 'strokeWidth'
        ? scalar(computed.get(node)?.get('stroke-width') ?? '1', 0, undefined, true)
        : 1;
    const { points, tangent } = pathPoints(node.get('d') ?? '');
    const [x, y] = points[points.length - 1];
    const nodeComputed = computed.get(node);
    if (
      (nodeComputed !== undefined &&
        (nodeComputed.has('opacity') || nodeComputed.has('clip-path'))) ||
      node.attrib.has('transform')
    ) {
      fail(
        'unsupported-css', 'markers',
        'Marker host transform, opacity or clip-path is unsupported',
      );
    }
    const angle = Math.atan2(tangent[1], tangent[0]) * (180 / Math.PI);
    const group = new DomElement(`{${SVG_NS}}g`);
    group.set(
      'transform',
      `translate(${gFormat(x)} ${gFormat(y)}) rotate(${gFormat(angle)}) `
        + `scale(${gFormat(scale)}) translate(${gFormat(-definition.refX)} ${gFormat(-definition.refY)})`,
    );
    group.set('fill', definition.paint);
    group.set('stroke', 'none');
    const clone = deepClone(definition.child);
    clone.attrib.delete('id');
    clone.set('fill', definition.paint);
    group.children.push(clone);
    const container = parent.get(node)!;
    container.children.splice(container.children.indexOf(node) + 1, 0, group);
    expanded += 1;
  }
  return expanded;
}

// ------------------------------------------------------------------
// The report (profile section 7)
// ------------------------------------------------------------------

export interface NormalizeChanges {
  style_elements: number;
  class_attributes: number;
  inline_styles: number;
  applied_declarations: number;
  expanded_markers: number;
}

export interface AccessibilityRecord {
  element: string;
  attribute: string;
  value: string;
  target?: string;
  loss?: string;
}

export interface NormalizeChecks {
  input: string;
  safe_svg: string;
  render: string;
  container: string;
  authenticity: string;
}

export interface RenderInfo {
  renderer: string;
  renderer_version: string;
  fonts: string;
  viewport: [number, number];
  background: string;
  color_alpha: string;
  resource_policy: string;
  comparison: string;
  tolerances: null;
  text_policy: string;
}

export interface ReportEntry {
  code: string;
  stage: string;
  explanation: string;
}

export interface ConversionReport {
  profile: string;
  status: string;
  input_sha256: string;
  output_sha256: string | null;
  changes: NormalizeChanges;
  accessibility: AccessibilityRecord[];
  checks: NormalizeChecks;
  render: RenderInfo | null;
  errors: ReportEntry[];
  warnings: ReportEntry[];
}

function emptyChanges(): NormalizeChanges {
  return {
    style_elements: 0,
    class_attributes: 0,
    inline_styles: 0,
    applied_declarations: 0,
    expanded_markers: 0,
  };
}

function skeletonReport(source: Uint8Array): ConversionReport {
  return {
    profile: PROFILE,
    status: 'failure',
    input_sha256: sha256Hex(source),
    output_sha256: null,
    changes: emptyChanges(),
    accessibility: [],
    checks: {
      input: 'pass',
      safe_svg: 'not-checked',
      render: 'not-checked',
      container: 'not-applicable',
      authenticity: 'not-verified',
    },
    render: null,
    errors: [],
    warnings: [],
  };
}

// ------------------------------------------------------------------
// Accessibility migration (profile section 5)
// ------------------------------------------------------------------

function migrateAccessibility(
  root: DomElement,
  ids: Map<string, DomElement>,
  locations: Map<DomElement, string>,
  originalText: Map<DomElement, string>,
  originalAria: Set<DomElement>,
): AccessibilityRecord[] {
  const records: AccessibilityRecord[] = [];
  const TEXT_ONLY = new Set(['title', 'desc', 'text', 'tspan']);
  for (const node of [...iterElements(root)]) {
    if (svgLocal(node.tag) === 'style') continue;
    const attrs = new Map(
      [...node.attrib].filter(([key]) => key === 'role' || key.startsWith('aria-')),
    );
    if (attrs.size === 0) continue;
    const resolve = (text: string): string => {
      const refs = pySplitWords(text);
      if (refs.length === 0 || new Set(refs).size !== refs.length) {
        fail(
          'invalid-reference', 'accessibility',
          'Accessibility ID lists must be nonempty and unique',
        );
      }
      const values: string[] = [];
      for (const ref of refs) {
        const target = ids.get(ref);
        if (
          target === undefined || target === node ||
          [...iterElements(target)].some(
            (t) => !TEXT_ONLY.has(svgLocal(t.tag)) || originalAria.has(t),
          )
        ) {
          fail(
            'invalid-reference', 'accessibility',
            `Accessibility target is missing or not text-only: ${ref}`,
          );
        }
        values.push(originalText.get(target)!);
      }
      return values.join(' ');
    };
    const name = attrs.has('aria-labelledby')
      ? resolve(attrs.get('aria-labelledby')!)
      : attrs.has('aria-label')
        ? pySplitWords(attrs.get('aria-label')!).join(' ')
        : null;
    const description = attrs.has('aria-describedby')
      ? resolve(attrs.get('aria-describedby')!)
      : null;
    const pairs: Array<[string, string | null]> = [
      ['title', name],
      ['desc', description],
    ];
    for (const [tag, newText] of pairs) {
      const existing = node.children.filter((c) => svgLocal(c.tag) === tag);
      if (existing.length > 1) {
        fail(
          'invalid-reference', 'accessibility',
          `Multiple direct ${tag} children are unsupported`,
        );
      }
      if (newText !== null) {
        if (existing.length === 1) {
          const current = existing[0];
          const oldText = iterText(current);
          if (oldText !== newText) {
            records.push({
              element: locations.get(node)!,
              attribute: tag,
              value: oldText,
              loss: 'replaced-text',
            });
          }
          current.children = [];
          current.text = newText;
        } else {
          const fresh = new DomElement(`{${SVG_NS}}${tag}`);
          fresh.text = newText;
          node.children.splice(tag === 'title' ? 0 : 1, 0, fresh);
        }
      }
    }
    for (const key of [...attrs.keys()].sort()) {
      const val = attrs.get(key)!;
      const target =
        key === 'aria-labelledby' ||
        (key === 'aria-label' && !attrs.has('aria-labelledby'))
          ? 'title'
          : key === 'aria-describedby'
            ? 'desc'
            : null;
      const record: AccessibilityRecord = {
        element: locations.get(node)!,
        attribute: key,
        value: val,
      };
      if (target !== null) record.target = target;
      else record.loss = key === 'aria-label' ? 'lower-priority-label' : 'unsupported-semantics';
      records.push(record);
      node.attrib.delete(key);
    }
  }
  return records;
}

// ------------------------------------------------------------------
// The transform (profile sections 3-5)
// ------------------------------------------------------------------

/** Where a cascaded winning declaration came from. */
type ChosenOrigin = 'attribute' | 'rule' | 'inline';

interface ChosenValue {
  value: string;
  origin: ChosenOrigin;
}

interface CascadeResult {
  computed: Map<DomElement, Map<string, string>>;
  chosen: Map<DomElement, Map<string, ChosenValue>>;
}

/**
 * The section 4 cascade: the winning declaration per element and
 * property, with its origin, and the computed values (cascade
 * plus inheritance). Performs every reference check and the
 * rx/ry element check in the Core's order and mutates nothing in
 * the tree. Shared by the transformation — which materializes
 * every winner as a presentation attribute — and by the render
 * gate, which materializes only the geometry winners resvg
 * cannot see in CSS (see gateInputText). When `changes` is
 * given, the inline-style count is recorded in it exactly where
 * the transformation counts it.
 */
function computeCascade(
  root: DomElement,
  rules: CssRule[],
  ids: Map<string, DomElement>,
  parent: Map<DomElement, DomElement>,
  budget: Budget,
  changes: NormalizeChanges | null,
): CascadeResult {
  const computed = new Map<DomElement, Map<string, string>>();
  const chosenByNode = new Map<DomElement, Map<string, ChosenValue>>();
  for (const node of [...iterElements(root)]) {
    if (svgLocal(node.tag) === 'style') continue;
    const ranked = new Map<string, [Rank, ChosenValue]>();
    for (const [key, val] of node.attrib) {
      if (PROPS.has(key)) {
        ranked.set(key, [[0, 0, 0, -1], { value: cssValue(key, val), origin: 'attribute' }]);
      }
    }
    for (const [selectors, decls] of rules) {
      const specs = selectors
        .filter((selector) => matchesSelector(selector, node))
        .map(specificity);
      if (specs.length > 0) {
        const maxSpec = specs.reduce((a, b) =>
          compareRank([0, ...a], [0, ...b]) >= 0 ? a : b,
        );
        for (const [prop, val] of decls) {
          checkRef(prop, val, ids, node, parent);
          const rank: Rank = [0, ...maxSpec];
          const current = ranked.get(prop);
          if (current === undefined || compareRank(rank, current[0]) >= 0) {
            ranked.set(prop, [rank, { value: val, origin: 'rule' }]);
          }
        }
      }
    }
    if (node.attrib.has('style')) {
      const inline = checkedCss(node.get('style')!);
      for (const [prop, val] of parseDeclarations(tokenizeCss(inline), budget)) {
        checkRef(prop, val, ids, node, parent);
        ranked.set(prop, [[1, 0, 0, 0], { value: val, origin: 'inline' }]);
      }
      if (changes !== null) changes.inline_styles += 1;
    }
    const chosen = new Map<string, ChosenValue>();
    for (const [prop, [, entry]] of ranked) {
      checkRef(prop, entry.value, ids, node, parent);
      if ((prop === 'rx' || prop === 'ry') && svgLocal(node.tag) !== 'rect') {
        fail('unsupported-css', 'css', 'CSS rx/ry apply only to rect');
      }
      chosen.set(prop, entry);
    }
    chosenByNode.set(node, chosen);
    const values = new Map<string, string>();
    const parentNode = parent.get(node);
    const parentComputed =
      parentNode !== undefined ? computed.get(parentNode) : undefined;
    if (parentComputed !== undefined) {
      for (const [key, val] of parentComputed) {
        if (INHERITED.has(key)) values.set(key, val);
      }
    }
    for (const [key, entry] of chosen) values.set(key, entry.value);
    computed.set(node, values);
  }
  return { computed, chosen: chosenByNode };
}

export interface NormalizeStructureResult {
  output: Uint8Array;
  report: ConversionReport;
}

/**
 * Transform input bytes; return (output bytes, analysis report).
 * The analysis report has render "not-checked" and status
 * "failure" by construction (mirroring the spec fixture tool):
 * only the gated entry point below may report success. Throws
 * NormalizeFailure (a section 7 code + stage) on any refusal.
 */
export function normalizeStructure(source: Uint8Array): NormalizeStructureResult {
  const text = preflightNormalize(source);
  const root = parseNormalizeTree(text);
  const { ids, locations, parent } = inspectTree(root);
  const originalText = new Map<DomElement, string>();
  for (const node of iterElements(root)) {
    originalText.set(node, pySplitWords(iterText(node)).join(' '));
  }
  const originalAria = new Set<DomElement>(
    [...iterElements(root)].filter((node) =>
      [...node.attrib.keys()].some((key) => key.startsWith('aria-')),
    ),
  );
  const budget = new Budget();
  const rules: CssRule[] = [];
  const changes = emptyChanges();
  for (const node of iterElements(root)) {
    if (svgLocal(node.tag) !== 'style') continue;
    rules.push(...parseStylesheet(node.text ?? '', budget));
  }
  // Every stylesheet declaration is reference-checked even when it
  // never wins or matches (profile section 2).
  for (const [, decls] of rules) {
    for (const [prop, val] of decls) checkRefTarget(prop, val, ids);
  }
  const { computed, chosen } = computeCascade(
    root, rules, ids, parent, budget, changes,
  );
  for (const node of [...iterElements(root)]) {
    if (svgLocal(node.tag) === 'style') continue;
    const nodeChosen = chosen.get(node)!;
    for (const [prop, entry] of nodeChosen) {
      node.set(prop, entry.value);
    }
    changes.applied_declarations += nodeChosen.size;
    if (node.attrib.has('class')) {
      changes.class_attributes += 1;
      node.attrib.delete('class');
    }
    node.attrib.delete('style');
  }
  const markers = new Map<DomElement, MarkerDefinition>();
  for (const node of iterElements(root)) {
    if (svgLocal(node.tag) === 'marker') {
      markers.set(node, markerDefinition(node, parent, computed));
    }
  }
  const accessibility = migrateAccessibility(
    root, ids, locations, originalText, originalAria,
  );
  changes.expanded_markers += expandMarkers(root, ids, parent, computed, markers);
  for (const node of [...iterElements(root)]) {
    for (const child of [...node.children]) {
      const local = svgLocal(child.tag);
      if (local === 'style' || local === 'marker') {
        if (local === 'style') changes.style_elements += 1;
        node.children.splice(node.children.indexOf(child), 1);
      }
    }
  }
  const output = serializeDom(root);
  if (output.length > MAX_BYTES) {
    fail('resource-limit', 'output', 'Normalized output exceeds 1,000,000 bytes');
  }
  try {
    validateSource(output);
  } catch (error) {
    if (error instanceof TsCoreError) {
      fail(
        'unsupported-css', 'output',
        `Normalized output does not satisfy safe-svg-v1: ${error.message}`,
      );
    }
    throw error;
  }
  const report: ConversionReport = {
    profile: PROFILE,
    status: 'failure',
    input_sha256: sha256Hex(source),
    output_sha256: null,
    changes,
    accessibility,
    checks: {
      input: 'pass',
      safe_svg: 'pass',
      render: 'not-checked',
      container: 'not-applicable',
      authenticity: 'not-verified',
    },
    render: null,
    errors: [],
    warnings: accessibility.some((record) => 'loss' in record)
      ? [{
          code: 'accessibility-loss',
          stage: 'accessibility',
          explanation: 'Review recorded semantic losses',
        }]
      : [],
  };
  return { output, report };
}

// ------------------------------------------------------------------
// Rendering gate (profile section 6)
// ------------------------------------------------------------------

export interface NormalizeRenderOptions {
  /** Font buffers used for BOTH gate renders (the same set). */
  fonts: FontBuffer[];
  defaultFontFamily?: string;
  sansSerifFamily?: string;
}

function viewportOf(root: DomElement): [number, number] {
  const decimal = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const match = new RegExp(`^(${NUMBER_SRC})(?:px)?$`).exec(pyStrip(raw));
    return match ? parseFloat(match[1]) : null;
  };
  let width = decimal(root.get('width'));
  let height = decimal(root.get('height'));
  if (width === null || height === null) {
    const viewBox = pySplitWords((root.get('viewBox') ?? '').replaceAll(',', ' '));
    if (viewBox.length === 4) {
      const w = pyFloat(viewBox[2]);
      const h = pyFloat(viewBox[3]);
      if (w !== null && h !== null) {
        width = w;
        height = h;
      } else {
        width = null;
        height = null;
      }
    }
  }
  if (width === null || height === null || width < 1 || height < 1) {
    width = 1024;
    height = 1024;
  }
  if (
    Number.isNaN(width) || Number.isNaN(height)
  ) {
    // Python raises ValueError from int(round(nan)) at this point;
    // surface the same unclassified failure rather than a code.
    throw new Error('cannot convert float NaN to integer');
  }
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    fail(
      'resource-limit', 'input',
      'Viewport exceeds 4096 pixels per side or 4,000,000 pixels',
    );
  }
  return [pyRound(width), pyRound(height)];
}

async function renderGateSide(
  text: string,
  width: number,
  height: number,
  options: NormalizeRenderOptions,
): Promise<Uint8Array> {
  const rendered = await renderSvgToPng(text, {
    width,
    height,
    fonts: options.fonts,
    defaultFontFamily: options.defaultFontFamily,
    sansSerifFamily: options.sansSerifFamily,
    // The gate's inputs have already passed section 2 inspection,
    // which rejects every real external reference; the renderer's
    // conservative raw-source scan would otherwise refuse text
    // content that merely mentions a reference-shaped string.
    skipExternalReferenceScan: true,
  });
  return rendered.png;
}

function checkRendererBytes(png: Uint8Array, stage: 'before' | 'after'): void {
  const signatureOk =
    png.length >= SIGNATURE.length &&
    SIGNATURE.every((byte, index) => png[index] === byte);
  if (png.length > MAX_PNG || !signatureOk) {
    if (stage === 'before') {
      fail('render-error', 'render', 'Renderer returned invalid or excessive PNG');
    }
    fail(
      'render-error', 'render',
      'After-render failed: SVG renderer returned invalid or excessive PNG',
    );
  }
}

/** The section 6 gate; mutates report as the Core's gate does. */
export async function renderGate(
  source: Uint8Array,
  output: Uint8Array,
  report: ConversionReport,
  options: NormalizeRenderOptions,
): Promise<void> {
  const root = parseNormalizeTree(
    new TextDecoder('utf-8').decode(output),
  );
  const [width, height] = viewportOf(root);
  // The before text is the input decoded as utf-8-sig, as in the
  // Core: a leading BOM (one U+FEFF after the strict decode) is
  // not part of the rendered document.
  let beforeText = new TextDecoder('utf-8', { ignoreBOM: false }).decode(source);
  if (beforeText.startsWith('\uFEFF')) beforeText = beforeText.slice(1);
  let before: Uint8Array;
  try {
    before = await renderGateSide(beforeText, width, height, options);
  } catch (error) {
    if (error instanceof TsCoreError) {
      fail('render-error', 'render', `Before-render failed: ${error.message}`);
    }
    throw error;
  }
  checkRendererBytes(before, 'before');
  const outputText = new TextDecoder('utf-8').decode(output);
  let after: Uint8Array;
  try {
    validateSource(output);
    after = await renderGateSide(outputText, width, height, options);
  } catch (error) {
    if (error instanceof TsCoreError) {
      fail('render-error', 'render', `After-render failed: ${error.message}`);
    }
    throw error;
  }
  checkRendererBytes(after, 'after');
  report.render = {
    renderer: '@resvg/resvg-wasm',
    renderer_version: '2.6.2',
    fonts: 'host-selected',
    viewport: [width, height],
    background: 'transparent',
    color_alpha: 'resvg default; transparent background',
    resource_policy: 'fetch denied',
    comparison: 'exact',
    tolerances: null,
    text_policy: 'resvg default antialiasing',
  };
  if (!rgbaEqual(decodePngRgba(before), decodePngRgba(after))) {
    report.checks.render = 'mismatch';
    fail(
      'render-mismatch', 'render',
      'Before/after renders differ under exact decoded RGBA equality',
    );
  }
  report.checks.render = 'pass';
}

// ------------------------------------------------------------------
// Gated entry point
// ------------------------------------------------------------------

/**
 * A refused normalization, carrying the section 7 failure report
 * the Core attaches to its CoreError details: callers read the
 * code/message for the headline and the report for the structured
 * errors and warnings.
 */
export class NormalizeRejection extends TsCoreError {
  readonly report: ConversionReport;

  constructor(code: string, message: string, report: ConversionReport) {
    super(code, message);
    this.name = 'NormalizeRejection';
    this.report = report;
  }
}

function failureReport(
  failure: NormalizeFailure,
  base: ConversionReport,
): ConversionReport {
  base.status = 'failure';
  base.output_sha256 = null;
  base.errors = [{
    code: failure.code,
    stage: failure.stage,
    explanation: failure.message.slice(0, 2000),
  }];
  if (failure.stage === 'input') {
    base.checks.input = 'fail';
    base.checks.safe_svg = 'not-checked';
  } else if (failure.stage === 'output') {
    base.checks.safe_svg = 'fail';
  } else if (failure.stage === 'render') {
    if (failure.code !== 'render-mismatch') base.checks.render = 'error';
  }
  return base;
}

export interface NormalizeDocumentResult {
  output: Uint8Array;
  report: ConversionReport;
}

/**
 * The gated normalization (the file-publication discipline of
 * the Core's normalize_document belongs to the caller, as it
 * does throughout this package): structure transform plus the
 * render gate. On success the report is completed (status
 * "success", output hash). On refusal, throws NormalizeRejection
 * with the failure report attached.
 */
export async function normalizeDocument(
  source: Uint8Array,
  options: NormalizeRenderOptions,
): Promise<NormalizeDocumentResult> {
  const skeleton = skeletonReport(source);
  let report: ConversionReport | undefined;
  try {
    const result = normalizeStructure(source);
    report = result.report;
    await renderGate(source, result.output, report, options);
    report.status = 'success';
    report.output_sha256 = sha256Hex(result.output);
    return { output: result.output, report };
  } catch (error) {
    if (error instanceof NormalizeFailure) {
      throw new NormalizeRejection(
        error.code,
        error.message,
        failureReport(error, report ?? skeleton),
      );
    }
    throw error;
  }
}
