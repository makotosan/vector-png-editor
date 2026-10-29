// ElementTree-shaped DOM for the svg-normalization-v1 port
// (src/normalize.ts), mirroring the Python Core's normalize.py
// parse pipeline:
//
// - _preflight runs a namespace-unaware expat pass over the raw
//   bytes: strict UTF-8, NUL forbidden, DTD / entity declarations
//   / processing instructions forbidden (hazard handler), an XML
//   declaration must name UTF-8 (compared case-insensitively),
//   at most 5,000 elements, depth 32, attribute values of at
//   most 100,000 code points.
// - _parse_tree then builds the tree with ElementTree semantics:
//   namespace expansion into "{uri}local" names, xmlns
//   declarations consumed, comments dropped (text around them
//   merges), CDATA treated as text, and the SVG-root check.
//
// Both passes share one scanner; each supplies its own failure
// mapping, exactly as the Core's two layers report the same
// document problems through different code/message pairs. The
// tree retains what the transform reads and rewrites: expanded
// tag names, insertion-ordered attributes (a JS Map has the same
// set-in-place / append-on-new semantics as a Python dict), text
// and tail content per element, and children in document order.
//
// serializeDom mirrors ET.tostring(root, encoding="utf-8") with
// the default namespace registered for the SVG namespace:
// namespace declarations first (the SVG namespace is declared on
// the root, its only reachable use site), attributes in
// insertion order, ElementTree's escaping (text: &, <, >;
// attribute values: &, <, >, ", and CR/LF/TAB as character
// references), empty elements in the `<tag ... />` form, and
// non-ASCII written as raw UTF-8.
import { TsCoreError } from './errors.ts';

export const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const MAX_BYTES = 1_000_000;
const MAX_ELEMENTS = 5000;
const MAX_DEPTH = 32;
const MAX_ATTRIBUTE_CODE_POINTS = 100_000;

const HAZARD_MESSAGE =
  'DTD, entity declarations and processing instructions are forbidden';

/** The profile failure of normalize.py: a section 7 code + stage. */
export class NormalizeFailure extends Error {
  readonly code: string;
  readonly stage: string;

  constructor(code: string, stage: string, message: string) {
    super(message);
    this.name = 'NormalizeFailure';
    this.code = code;
    this.stage = stage;
  }
}

export class DomElement {
  /** ElementTree expanded name: "{ns}local", or "local". */
  tag: string;
  /** Insertion-ordered attributes (Python dict semantics). */
  attrib = new Map<string, string>();
  text: string | null = null;
  tail: string | null = null;
  children: DomElement[] = [];

  constructor(tag: string) {
    this.tag = tag;
  }

  get(name: string): string | undefined {
    return this.attrib.get(name);
  }

  set(name: string, value: string): void {
    this.attrib.set(name, value);
  }
}

/** normalize.py's _local: strip the SVG namespace expansion only. */
export function svgLocal(tag: string): string {
  const prefix = `{${SVG_NS}}`;
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
}

/** root.iter(): preorder traversal including the root itself. */
export function* iterElements(root: DomElement): Generator<DomElement> {
  yield root;
  for (const child of root.children) yield* iterElements(child);
}

/** "".join(node.itertext()): text and tails in document order. */
export function iterText(el: DomElement): string {
  let out = '';
  if (el.text) out += el.text;
  for (const child of el.children) {
    out += iterText(child);
    if (child.tail) out += child.tail;
  }
  return out;
}

/** copy.deepcopy of an element subtree (attributes copied too). */
export function deepClone(el: DomElement): DomElement {
  const clone = new DomElement(el.tag);
  clone.attrib = new Map(el.attrib);
  clone.text = el.text;
  clone.tail = el.tail;
  clone.children = el.children.map(deepClone);
  return clone;
}

// ------------------------------------------------------------------
// Shared scanner. fail(kind, detail) maps a scan problem onto the
// caller's failure type; kinds: 'hazard' | 'decl-encoding' |
// 'limit-count' | 'limit-attr' | 'malformed'.
// ------------------------------------------------------------------

type FailKind =
  | 'hazard'
  | 'decl-encoding'
  | 'limit-count'
  | 'limit-attr'
  | 'malformed';
type FailFn = (kind: FailKind, detail: string) => never;

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function isValidXmlChar(cp: number): boolean {
  return (
    cp === 0x9 || cp === 0xa || cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function isNameStartChar(cp: number): boolean {
  return (
    cp === 0x3a || (cp >= 0x41 && cp <= 0x5a) || cp === 0x5f ||
    (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0xd6) ||
    (cp >= 0xd8 && cp <= 0xf6) || (cp >= 0xf8 && cp <= 0x2ff) ||
    (cp >= 0x370 && cp <= 0x37d) || (cp >= 0x37f && cp <= 0x1fff) ||
    (cp >= 0x200c && cp <= 0x200d) || (cp >= 0x2070 && cp <= 0x218f) ||
    (cp >= 0x2c00 && cp <= 0x2fef) || (cp >= 0x3001 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfdcf) || (cp >= 0xfdf0 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0xeffff)
  );
}

function isNameChar(cp: number): boolean {
  return (
    isNameStartChar(cp) || cp === 0x2d || cp === 0x2e ||
    (cp >= 0x30 && cp <= 0x39) || cp === 0xb7 ||
    (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x203f && cp <= 0x2040)
  );
}

interface RawElement {
  qname: string;
  attrs: Array<[string, string]>;
  children: RawElement[];
  text: string | null;
  tail: string | null;
  /** 1-based line / 0-based column of the start tag's '<'. */
  line: number;
  column: number;
}

class Scanner {
  private readonly s: string;
  private readonly fail: FailFn;
  private i = 0;
  private line = 1;
  private column = 0;
  private count = 0;
  private depth = -1;

  constructor(text: string, fail: FailFn) {
    // expat normalizes CRLF and CR line endings to LF before
    // tokenizing; positions and values follow the normalized text.
    this.s = text.replace(/\r\n|\r/g, '\n');
    this.fail = fail;
  }

  private get eof(): boolean {
    return this.i >= this.s.length;
  }

  private peek(): number {
    return this.i < this.s.length ? this.s.codePointAt(this.i)! : -1;
  }

  private startsWith(literal: string): boolean {
    return this.s.startsWith(literal, this.i);
  }

  private step(): number {
    const cp = this.s.codePointAt(this.i)!;
    this.i += cp > 0xffff ? 2 : 1;
    if (cp === 0xa) {
      this.line += 1;
      this.column = 0;
    } else {
      this.column += 1;
    }
    return cp;
  }

  private skipWhitespace(): boolean {
    let consumed = false;
    while (!this.eof) {
      const cp = this.peek();
      if (cp === 0x20 || cp === 0x9 || cp === 0xa) {
        this.step();
        consumed = true;
      } else {
        break;
      }
    }
    return consumed;
  }

  private readName(): string {
    const start = this.i;
    if (this.eof || !isNameStartChar(this.peek())) return '';
    this.step();
    while (!this.eof && isNameChar(this.peek())) this.step();
    return this.s.slice(start, this.i);
  }

  private parseReference(): string {
    this.step(); // '&'
    if (this.peek() === 0x23) {
      this.step(); // '#'
      let cp: number;
      if (this.peek() === 0x78) {
        this.step();
        const start = this.i;
        while (!this.eof && /[0-9A-Fa-f]/.test(this.s[this.i])) this.step();
        if (this.i === start) this.fail('malformed', 'invalid character reference');
        cp = parseInt(this.s.slice(start, this.i), 16);
      } else {
        const start = this.i;
        while (!this.eof && /[0-9]/.test(this.s[this.i])) this.step();
        if (this.i === start) this.fail('malformed', 'invalid character reference');
        cp = parseInt(this.s.slice(start, this.i), 10);
      }
      if (this.peek() !== 0x3b) this.fail('malformed', 'unterminated reference');
      this.step();
      if (!isValidXmlChar(cp)) this.fail('malformed', 'invalid character in reference');
      return String.fromCodePoint(cp);
    }
    const name = this.readName();
    if (name === '' || this.peek() !== 0x3b) {
      this.fail('malformed', 'unterminated entity reference');
    }
    this.step(); // ';'
    const value = PREDEFINED_ENTITIES[name];
    if (value === undefined) this.fail('malformed', `undefined entity: ${name}`);
    return value;
  }

  /** Scan a comment; when collecting, it contributes nothing. */
  private parseComment(): void {
    this.i += 4;
    this.column += 4;
    for (;;) {
      if (this.eof) this.fail('malformed', 'unclosed comment');
      if (this.startsWith('--')) {
        if (this.s[this.i + 2] === '>') {
          this.i += 3;
          this.column += 3;
          return;
        }
        this.fail('malformed', '"--" inside comment');
      }
      const cp = this.step();
      if (!isValidXmlChar(cp)) this.fail('malformed', 'invalid character in comment');
    }
  }

  /** Scan a CDATA section; returns its raw content. */
  private parseCdata(): string {
    this.i += 9;
    this.column += 9;
    const parts: string[] = [];
    for (;;) {
      if (this.eof) this.fail('malformed', 'unclosed CDATA section');
      if (this.startsWith(']]>')) {
        this.i += 3;
        this.column += 3;
        return parts.join('');
      }
      const cp = this.step();
      if (!isValidXmlChar(cp)) this.fail('malformed', 'invalid character in CDATA');
      parts.push(String.fromCodePoint(cp));
    }
  }

  private parseProcessingInstruction(): void {
    this.i += 2;
    this.column += 2;
    const target = this.readName();
    if (target === '') this.fail('malformed', 'invalid processing instruction');
    if (target.toLowerCase() === 'xml') {
      this.fail('malformed', 'XML declaration is only allowed at the start');
    }
    if (!this.eof && !this.startsWith('?>')) {
      const cp = this.peek();
      if (cp !== 0x20 && cp !== 0x9 && cp !== 0xa) {
        this.fail('malformed', 'invalid processing instruction');
      }
    }
    for (;;) {
      if (this.eof) this.fail('malformed', 'unclosed processing instruction');
      if (this.startsWith('?>')) {
        this.i += 2;
        this.column += 2;
        this.fail('hazard', HAZARD_MESSAGE);
      }
      const cp = this.step();
      if (!isValidXmlChar(cp)) {
        this.fail('malformed', 'invalid character in processing instruction');
      }
    }
  }

  private parseDoctype(): void {
    // expat reports the doctype once its name is read.
    this.i += 9;
    this.column += 9;
    if (!this.skipWhitespace()) this.fail('malformed', 'invalid doctype');
    if (this.readName() === '') this.fail('malformed', 'invalid doctype');
    this.fail('hazard', HAZARD_MESSAGE);
  }

  private parseXmlDeclaration(): void {
    // Same declaration behaviour as the Core's other expat pass:
    // fixed pseudo-attribute order, unchecked version name-token,
    // encoding must be a valid encoding name; the caller's mapping
    // decides how a non-UTF-8 encoding is reported.
    this.i += 5;
    this.column += 5;
    if (!this.skipWhitespace()) this.fail('malformed', 'invalid XML declaration');
    const pseudo = (name: string, required: boolean): string | null => {
      if (!this.startsWith(name)) {
        if (required) this.fail('malformed', 'invalid XML declaration');
        return null;
      }
      this.i += name.length;
      this.column += name.length;
      this.skipWhitespace();
      if (this.peek() !== 0x3d) this.fail('malformed', 'invalid XML declaration');
      this.step();
      this.skipWhitespace();
      const quote = this.peek();
      if (quote !== 0x22 && quote !== 0x27) {
        this.fail('malformed', 'invalid XML declaration');
      }
      this.step();
      const start = this.i;
      while (!this.eof && this.peek() !== quote) this.step();
      if (this.eof) this.fail('malformed', 'invalid XML declaration');
      const value = this.s.slice(start, this.i);
      this.step(); // closing quote
      return value;
    };
    const version = pseudo('version', true)!;
    if (!/^[A-Za-z0-9_.:-]*$/.test(version)) {
      this.fail('malformed', 'invalid XML declaration');
    }
    let hadWhitespace = this.skipWhitespace();
    if (this.startsWith('encoding')) {
      if (!hadWhitespace) this.fail('malformed', 'invalid XML declaration');
      const encoding = pseudo('encoding', true)!;
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) {
        this.fail('malformed', 'invalid XML declaration');
      }
      if (encoding.toLowerCase() !== 'utf-8') {
        this.fail('decl-encoding', encoding);
      }
      hadWhitespace = this.skipWhitespace();
    }
    if (this.startsWith('standalone')) {
      if (!hadWhitespace) this.fail('malformed', 'invalid XML declaration');
      const standalone = pseudo('standalone', true)!;
      if (standalone !== 'yes' && standalone !== 'no') {
        this.fail('malformed', 'invalid XML declaration');
      }
      this.skipWhitespace();
    }
    if (!this.startsWith('?>')) this.fail('malformed', 'invalid XML declaration');
    this.i += 2;
    this.column += 2;
  }

  private readAttributeValue(quote: number): string {
    const parts: string[] = [];
    for (;;) {
      if (this.eof) this.fail('malformed', 'unclosed attribute value');
      const cp = this.peek();
      if (cp === quote) {
        this.step();
        return parts.join('');
      }
      if (cp === 0x3c) this.fail('malformed', '"<" in attribute value');
      if (cp === 0x26) {
        parts.push(this.parseReference());
        continue;
      }
      this.step();
      if (!isValidXmlChar(cp)) {
        this.fail('malformed', 'invalid character in attribute value');
      }
      // CDATA-type attribute-value normalization: literal tab and
      // newline become a space; character references are literal.
      parts.push(cp === 0x9 || cp === 0xa ? ' ' : String.fromCodePoint(cp));
    }
  }

  /** One text run up to '<' or EOF, with references expanded. */
  private parseTextRun(): string {
    const parts: string[] = [];
    for (;;) {
      if (this.eof || this.peek() === 0x3c) return parts.join('');
      if (this.startsWith(']]>')) this.fail('malformed', '"]]>" in text');
      const cp = this.peek();
      if (cp === 0x26) {
        parts.push(this.parseReference());
        continue;
      }
      this.step();
      if (!isValidXmlChar(cp)) this.fail('malformed', 'invalid character in text');
      parts.push(String.fromCodePoint(cp));
    }
  }

  private parseElement(): RawElement {
    const line = this.line;
    const column = this.column;
    this.step(); // '<'
    const qname = this.readName();
    if (qname === '') this.fail('malformed', 'invalid element name');
    const attrs: Array<[string, string]> = [];
    const seen = new Set<string>();
    let empty = false;
    for (;;) {
      const hadWhitespace = this.skipWhitespace();
      if (this.eof) this.fail('malformed', 'unclosed start tag');
      if (this.startsWith('/>')) {
        this.i += 2;
        this.column += 2;
        empty = true;
        break;
      }
      if (this.peek() === 0x3e) {
        this.step();
        break;
      }
      if (!hadWhitespace) this.fail('malformed', 'invalid start tag');
      const attrLine = this.line;
      const attrColumn = this.column;
      const name = this.readName();
      if (name === '') this.fail('malformed', 'invalid attribute name');
      if (seen.has(name)) {
        this.fail(
          'malformed',
          `duplicate attribute: line ${attrLine}, column ${attrColumn}`,
        );
      }
      seen.add(name);
      this.skipWhitespace();
      if (this.peek() !== 0x3d) this.fail('malformed', 'invalid attribute');
      this.step();
      this.skipWhitespace();
      const quote = this.peek();
      if (quote !== 0x22 && quote !== 0x27) {
        this.fail('malformed', 'invalid attribute value');
      }
      this.step();
      attrs.push([name, this.readAttributeValue(quote)]);
    }
    // The Core's expat start-element handler applies the limits
    // when the start tag completes, before any content is read.
    this.count += 1;
    this.depth += 1;
    if (this.count > MAX_ELEMENTS || this.depth > MAX_DEPTH) {
      this.fail('limit-count', '');
    }
    for (const [, value] of attrs) {
      if ([...value].length > MAX_ATTRIBUTE_CODE_POINTS) {
        this.fail('limit-attr', '');
      }
    }
    const node: RawElement = {
      qname, attrs, children: [], text: null, tail: null, line, column,
    };
    if (empty) {
      this.depth -= 1;
      return node;
    }
    const appendText = (chunk: string): void => {
      if (chunk === '') return;
      const last = node.children[node.children.length - 1];
      if (last === undefined) {
        node.text = (node.text ?? '') + chunk;
      } else {
        last.tail = (last.tail ?? '') + chunk;
      }
    };
    for (;;) {
      if (this.eof) this.fail('malformed', 'unclosed element');
      if (this.startsWith('</')) {
        this.i += 2;
        this.column += 2;
        const name = this.readName();
        this.skipWhitespace();
        if (this.peek() !== 0x3e) this.fail('malformed', 'invalid end tag');
        this.step();
        if (name !== qname) this.fail('malformed', 'mismatched tag');
        this.depth -= 1;
        return node;
      }
      if (this.startsWith('<!--')) {
        this.parseComment();
        continue;
      }
      if (this.startsWith('<![CDATA[')) {
        appendText(this.parseCdata());
        continue;
      }
      if (this.startsWith('<!DOCTYPE')) {
        this.parseDoctype();
        continue;
      }
      if (this.startsWith('<!')) this.fail('malformed', 'invalid markup');
      if (this.startsWith('<?')) {
        this.parseProcessingInstruction();
        continue;
      }
      if (this.peek() === 0x3c) {
        node.children.push(this.parseElement());
        continue;
      }
      appendText(this.parseTextRun());
    }
  }

  private parseMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.eof) return;
      if (this.startsWith('<!--')) {
        this.parseComment();
        continue;
      }
      if (this.startsWith('<?')) {
        this.parseProcessingInstruction();
        continue;
      }
      if (this.startsWith('<!DOCTYPE')) {
        this.parseDoctype();
        continue;
      }
      if (this.startsWith('<!')) this.fail('malformed', 'invalid markup');
      if (this.peek() === 0x3c) return;
      this.fail('malformed', 'content outside the root element');
    }
  }

  parseDocument(): RawElement {
    // A leading U+FEFF is the decoded UTF-8 BOM: expat steps over
    // it as the signature.
    if (this.peek() === 0xfeff) this.step();
    if (
      this.startsWith('<?xml') &&
      (this.s[this.i + 5] === '?' ||
        this.s[this.i + 5] === ' ' ||
        this.s[this.i + 5] === '\t' ||
        this.s[this.i + 5] === '\n')
    ) {
      this.parseXmlDeclaration();
    }
    this.parseMisc();
    if (this.eof) this.fail('malformed', 'no root element');
    const root = this.parseElement();
    this.parseMisc();
    if (!this.eof) this.fail('malformed', 'content after the root element');
    return root;
  }
}

// ------------------------------------------------------------------
// Namespace expansion (ElementTree layer)
// ------------------------------------------------------------------

function failTree(detail: string): never {
  throw new NormalizeFailure('invalid-xml', 'input', `Malformed XML: ${detail}`);
}

function resolveQualifiedName(
  qname: string,
  scope: Map<string, string>,
  isAttribute: boolean,
  raw: RawElement,
): { ns: string | null; local: string } {
  const colon = qname.indexOf(':');
  if (colon === -1) {
    if (isAttribute) return { ns: null, local: qname };
    const uri = scope.get('');
    return { ns: uri ? uri : null, local: qname };
  }
  const prefix = qname.slice(0, colon);
  const local = qname.slice(colon + 1);
  if (local === '' || local.includes(':')) {
    failTree(`invalid qualified name: line ${raw.line}, column ${raw.column}`);
  }
  if (prefix === 'xmlns') {
    failTree(`reserved prefix (xmlns): line ${raw.line}, column ${raw.column}`);
  }
  if (prefix === 'xml') return { ns: XML_NS, local };
  const uri = scope.get(prefix);
  if (!uri) {
    failTree(`unbound prefix: line ${raw.line}, column ${raw.column}`);
  }
  return { ns: uri, local };
}

function expandNamespaces(
  raw: RawElement,
  inherited: Map<string, string>,
): DomElement {
  const scope = new Map(inherited);
  for (const [name, value] of raw.attrs) {
    if (name === 'xmlns') {
      scope.set('', value);
    } else if (name.startsWith('xmlns:')) {
      const prefix = name.slice(6);
      if (prefix === '' || prefix === 'xmlns') {
        failTree(
          prefix === ''
            ? `invalid namespace declaration: line ${raw.line}, column ${raw.column}`
            : `reserved prefix (xmlns) must not be undeclared or bound to another namespace name: line ${raw.line}, column ${raw.column}`,
        );
      }
      if (prefix === 'xml') {
        if (value !== XML_NS) {
          failTree(
            `reserved prefix (xml) must not be undeclared or bound to another namespace name: line ${raw.line}, column ${raw.column}`,
          );
        }
      } else if (value === '') {
        failTree(`must not undeclare prefix: line ${raw.line}, column ${raw.column}`);
      } else {
        scope.set(prefix, value);
      }
    }
  }
  const { ns, local } = resolveQualifiedName(raw.qname, scope, false, raw);
  const node = new DomElement(ns === null ? local : `{${ns}}${local}`);
  node.text = raw.text;
  const expanded = new Set<string>();
  for (const [name, value] of raw.attrs) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const resolved = resolveQualifiedName(name, scope, true, raw);
    const key = resolved.ns === null
      ? resolved.local
      : `{${resolved.ns}}${resolved.local}`;
    if (expanded.has(key)) {
      failTree(`duplicate attribute: line ${raw.line}, column ${raw.column}`);
    }
    expanded.add(key);
    node.attrib.set(key, value);
  }
  for (const child of raw.children) {
    const expandedChild = expandNamespaces(child, scope);
    expandedChild.tail = child.tail;
    node.children.push(expandedChild);
  }
  return node;
}

// ------------------------------------------------------------------
// The two parse layers of normalize.py
// ------------------------------------------------------------------

/**
 * _preflight: byte limits, strict UTF-8, NUL, and the hazard /
 * declaration / size rules of the Core's namespace-unaware expat
 * pass. Returns the decoded text (a decoded BOM is retained, as
 * in the Core, where only the parsers step over it).
 */
export function preflightNormalize(source: Uint8Array): string {
  if (source.length > MAX_BYTES) {
    throw new NormalizeFailure(
      'resource-limit', 'input', 'Input exceeds 1,000,000 bytes',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      source,
    );
  } catch {
    throw new NormalizeFailure(
      'invalid-xml', 'input', 'Input is not strict UTF-8',
    );
  }
  if (text.includes('\x00')) {
    throw new NormalizeFailure('invalid-xml', 'input', 'NUL is forbidden');
  }
  const fail: FailFn = (kind, detail) => {
    switch (kind) {
      case 'hazard':
        throw new NormalizeFailure('unsafe-input', 'input', detail);
      case 'decl-encoding':
        throw new NormalizeFailure(
          'invalid-xml', 'input', 'XML declaration must use UTF-8',
        );
      case 'limit-count':
        throw new NormalizeFailure(
          'resource-limit', 'input',
          'Input exceeds 5000 elements or depth 32',
        );
      case 'limit-attr':
        throw new NormalizeFailure(
          'resource-limit', 'input',
          'Attribute exceeds 100,000 code points',
        );
      default:
        throw new NormalizeFailure(
          'invalid-xml', 'input', `Malformed XML: ${detail}`,
        );
    }
  };
  new Scanner(text, fail).parseDocument();
  return text;
}

/**
 * _parse_tree: ElementTree-shaped parse of preflight-clean text,
 * with the SVG-root check of the Core's tree layer.
 */
export function parseNormalizeTree(text: string): DomElement {
  const fail: FailFn = (_kind, detail) => {
    // The preflight pass has already reported every hazard and
    // limit; anything the tree pass still trips on is reported
    // the way ElementTree reports it.
    failTree(detail);
  };
  const raw = new Scanner(text, fail).parseDocument();
  const root = expandNamespaces(raw, new Map());
  if (root.tag !== `{${SVG_NS}}svg`) {
    throw new NormalizeFailure(
      'unsafe-input', 'input', 'Root must be SVG in the SVG namespace',
    );
  }
  return root;
}

// ------------------------------------------------------------------
// Serialization (ET.tostring with encoding="utf-8")
// ------------------------------------------------------------------

function escapeText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttrib(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\t', '&#09;');
}

interface NamespacePlan {
  /** Prefix per namespace URI ("" for the default namespace). */
  prefixes: Map<string, string>;
  /** Namespace declarations to emit per element (first use wins). */
  declarations: Map<DomElement, Array<[string, string]>>;
}

function planNamespaces(root: DomElement): NamespacePlan {
  const prefixes = new Map<string, string>([[SVG_NS, '']]);
  const declarations = new Map<DomElement, Array<[string, string]>>();
  const declared = new Set<string>();
  let generated = 0;
  const use = (el: DomElement, ns: string | null): void => {
    if (ns === null || declared.has(ns)) return;
    if (!prefixes.has(ns)) prefixes.set(ns, `ns${generated++}`);
    declared.add(ns);
    const list = declarations.get(el) ?? [];
    list.push([prefixes.get(ns)!, ns]);
    declarations.set(el, list);
  };
  const walk = (el: DomElement): void => {
    const colon = el.tag.indexOf('}');
    use(el, el.tag.startsWith('{') ? el.tag.slice(1, colon) : null);
    for (const name of el.attrib.keys()) {
      if (name.startsWith('{')) use(el, name.slice(1, name.indexOf('}')));
    }
    for (const child of el.children) walk(child);
  };
  walk(root);
  return { prefixes, declarations };
}

function writtenName(expanded: string, prefixes: Map<string, string>): string {
  if (!expanded.startsWith('{')) return expanded;
  const colon = expanded.indexOf('}');
  const ns = expanded.slice(1, colon);
  const local = expanded.slice(colon + 1);
  const prefix = prefixes.get(ns) ?? '';
  return prefix === '' ? local : `${prefix}:${local}`;
}

function writeElement(
  el: DomElement,
  plan: NamespacePlan,
  out: string[],
): void {
  const tag = writtenName(el.tag, plan.prefixes);
  out.push('<', tag);
  for (const [prefix, uri] of plan.declarations.get(el) ?? []) {
    out.push(prefix === '' ? ` xmlns="${escapeAttrib(uri)}"` : ` xmlns:${prefix}="${escapeAttrib(uri)}"`);
  }
  for (const [name, value] of el.attrib) {
    out.push(` ${writtenName(name, plan.prefixes)}="${escapeAttrib(value)}"`);
  }
  if (el.text || el.children.length > 0) {
    out.push('>');
    if (el.text) out.push(escapeText(el.text));
    for (const child of el.children) {
      writeElement(child, plan, out);
      if (child.tail) out.push(escapeText(child.tail));
    }
    out.push(`</${tag}>`);
  } else {
    out.push(' />');
  }
}

/**
 * ET.tostring(root, encoding="utf-8") for a normalization tree:
 * no XML declaration, namespaces declared at first use (the SVG
 * namespace on the root), ElementTree escaping throughout.
 */
export function serializeDom(root: DomElement): Uint8Array {
  const plan = planNamespaces(root);
  const parts: string[] = [];
  writeElement(root, plan, parts);
  return new TextEncoder().encode(parts.join(''));
}

// TsCoreError is re-exported for callers that branch on Core codes
// uniformly across the package.
export { TsCoreError };
