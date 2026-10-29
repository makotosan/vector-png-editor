// Bounded UTF-8 XML parsing for SVG sources, mirroring the retired
// Python Core's svg.parse_source (originally
// vector_png_editor/svg.py) and the tree views its consumers build
// from it.
//
// The original parses twice: an expat pass enforces the hard limits and
// prohibitions (no DTD, no entity declarations, no external
// entities, no processing instructions; at most 5,000 elements,
// depth 32, attribute values of at most 100,000 code points; an
// XML declaration must declare UTF-8), and an ElementTree pass then
// applies namespace expansion and the SVG-root check. This module
// reproduces both layers, in that order: a streaming parse over the
// raw qualified names applies every first-layer rule in document
// order, then a scope-resolving walk expands namespaces over the
// finished tree (namespace failures are the Core's catch-all
// 'Malformed XML', as they are when ElementTree raises), then the
// root check runs. No catalogue XML parser is used: the repo has
// none (the extension depends only on monaco-editor; the bridge and
// this package have no XML dependency), and verdict/position parity
// with expat — line/column counted in code points from each start
// tag's '<', BOM counted as one column — is a property of this
// specific two-layer behaviour, not of XML parsing in general.
//
// The tree carries what the Core's consumers read: expanded names
// (kept as namespace + local, formatted on demand — ElementTree's
// "{ns}local" for validation, expat's "ns}local" for profile
// diagnostics), attribute values after entity expansion and
// attribute-value normalization, children in document order, and
// each element's start-tag position. Text content is validated
// (character validity, references, the forbidden "]]>") but not
// retained, exactly as the Core's checks ignore it.
import { TsCoreError } from './errors.ts';

export const MAX_SVG = 1_000_000;
export const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const MAX_ELEMENTS = 5000;
const MAX_DEPTH = 32;
const MAX_ATTRIBUTE_CODE_POINTS = 100_000;

const PROHIBITED = 'DTD, entities and processing instructions are forbidden';
const MALFORMED = 'Malformed XML';

export interface XmlAttribute {
  ns: string | null;
  local: string;
  value: string;
}

export interface XmlElement {
  ns: string | null;
  local: string;
  attrs: XmlAttribute[];
  children: XmlElement[];
  parent: XmlElement | null;
  /** 1-based line of the start tag's '<'. */
  line: number;
  /** 0-based column of the start tag's '<', in code points. */
  column: number;
}

/** ElementTree name form: "{ns}local", or "local" without a namespace. */
export function etName(ns: string | null, local: string): string {
  return ns === null ? local : `{${ns}}${local}`;
}

/** expat namespace-separator name form: "ns}local", or "local". */
export function profileName(ns: string | null, local: string): string {
  return ns === null ? local : `${ns}}${local}`;
}

function malformed(): TsCoreError {
  return new TsCoreError('invalid-svg', MALFORMED);
}

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

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

interface RawElement {
  qname: string;
  attrs: Array<[string, string]>;
  children: RawElement[];
  parent: RawElement | null;
  line: number;
  column: number;
}

class Parser {
  private readonly s: string;
  private i = 0; // UTF-16 index into s
  private line = 1;
  private column = 0;
  private count = 0;
  private depth = -1;

  constructor(text: string) {
    // The Core hands expat the raw bytes; expat normalizes CRLF and
    // CR line endings to LF before tokenizing. Positions and values
    // below are therefore computed on the normalized text.
    this.s = text.replace(/\r\n|\r/g, '\n');
  }

  private get eof(): boolean {
    return this.i >= this.s.length;
  }

  /** Code point at the cursor, or -1 at end of input. */
  private peek(): number {
    return this.i < this.s.length ? this.s.codePointAt(this.i)! : -1;
  }

  private startsWith(literal: string): boolean {
    return this.s.startsWith(literal, this.i);
  }

  /** Consume one code point, tracking line/column. Returns it. */
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

  /** Parse a reference at the cursor ('&' current). Returns its character(s). */
  private parseReference(): string {
    this.step(); // '&'
    if (this.peek() === 0x23) {
      // Character reference.
      this.step(); // '#'
      let cp: number;
      if (this.peek() === 0x78) {
        // 'x'
        this.step();
        const start = this.i;
        while (!this.eof && /[0-9A-Fa-f]/.test(this.s[this.i])) this.step();
        if (this.i === start) throw malformed();
        cp = parseInt(this.s.slice(start, this.i), 16);
      } else {
        const start = this.i;
        while (!this.eof && /[0-9]/.test(this.s[this.i])) this.step();
        if (this.i === start) throw malformed();
        cp = parseInt(this.s.slice(start, this.i), 10);
      }
      if (this.peek() !== 0x3b) throw malformed(); // ';'
      this.step();
      if (!isValidXmlChar(cp)) throw malformed();
      return String.fromCodePoint(cp);
    }
    const name = this.readName();
    if (name === '' || this.peek() !== 0x3b) throw malformed();
    this.step(); // ';'
    const value = PREDEFINED_ENTITIES[name];
    if (value === undefined) throw malformed(); // undefined entity
    return value;
  }

  private parseComment(): void {
    // Cursor at "<!--".
    this.i += 4;
    this.column += 4;
    for (;;) {
      if (this.eof) throw malformed();
      if (this.startsWith('--')) {
        if (this.s[this.i + 2] === '>') {
          this.i += 3;
          this.column += 3;
          return;
        }
        throw malformed(); // "--" inside a comment
      }
      const cp = this.step();
      if (!isValidXmlChar(cp)) throw malformed();
    }
  }

  private parseCdata(): void {
    // Cursor at "<![CDATA["; content is raw text up to "]]>".
    this.i += 9;
    this.column += 9;
    for (;;) {
      if (this.eof) throw malformed();
      if (this.startsWith(']]>')) {
        this.i += 3;
        this.column += 3;
        return;
      }
      const cp = this.step();
      if (!isValidXmlChar(cp)) throw malformed();
    }
  }

  private parseProcessingInstruction(): void {
    // Cursor at "<?". The XML declaration is handled separately and
    // only at the document start; a target of "xml" anywhere else
    // is a parse error, and every other PI is prohibited outright.
    this.i += 2;
    this.column += 2;
    const target = this.readName();
    if (target === '') throw malformed();
    if (target.toLowerCase() === 'xml') throw malformed();
    if (!this.eof && !this.startsWith('?>')) {
      const cp = this.peek();
      if (cp !== 0x20 && cp !== 0x9 && cp !== 0xa) throw malformed();
    }
    for (;;) {
      if (this.eof) throw malformed();
      if (this.startsWith('?>')) {
        this.i += 2;
        this.column += 2;
        throw new TsCoreError('invalid-svg', PROHIBITED);
      }
      const cp = this.step();
      if (!isValidXmlChar(cp)) throw malformed();
    }
  }

  private parseDoctype(): void {
    // Cursor at "<!DOCTYPE". expat reports the doctype (the
    // prohibited handler) once its name is read; anything too
    // broken to name is a plain parse error.
    this.i += 9;
    this.column += 9;
    if (!this.skipWhitespace()) throw malformed();
    if (this.readName() === '') throw malformed();
    throw new TsCoreError('invalid-svg', PROHIBITED);
  }

  private parseXmlDeclaration(): void {
    // Cursor at "<?xml" followed by whitespace or '?'. Mirrors the
    // declaration behaviour the Core relies on: the pseudo-attribute
    // order is fixed, the version is an unchecked name-token (expat
    // accepts any), the encoding name must be a valid encoding name
    // and must name UTF-8 (the Core's declaration handler compares
    // case-insensitively against "utf-8"), standalone is yes/no.
    this.i += 5;
    this.column += 5;
    if (!this.skipWhitespace()) throw malformed();
    const pseudo = (name: string, required: boolean): string | null => {
      if (!this.startsWith(name)) {
        if (required) throw malformed();
        return null;
      }
      this.i += name.length;
      this.column += name.length;
      this.skipWhitespace();
      if (this.peek() !== 0x3d) throw malformed(); // '='
      this.step();
      this.skipWhitespace();
      const quote = this.peek();
      if (quote !== 0x22 && quote !== 0x27) throw malformed();
      this.step();
      const start = this.i;
      while (!this.eof && this.peek() !== quote) this.step();
      if (this.eof) throw malformed();
      const value = this.s.slice(start, this.i);
      this.step(); // closing quote
      return value;
    };
    const version = pseudo('version', true)!;
    if (!/^[A-Za-z0-9_.:-]*$/.test(version)) throw malformed();
    let hadWhitespace = this.skipWhitespace();
    if (this.startsWith('encoding')) {
      if (!hadWhitespace) throw malformed();
      const encoding = pseudo('encoding', true)!;
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) throw malformed();
      if (encoding.toLowerCase() !== 'utf-8') {
        throw new TsCoreError('invalid-svg', 'XML declaration must use UTF-8');
      }
      hadWhitespace = this.skipWhitespace();
    }
    if (this.startsWith('standalone')) {
      if (!hadWhitespace) throw malformed();
      const standalone = pseudo('standalone', true)!;
      if (standalone !== 'yes' && standalone !== 'no') throw malformed();
      this.skipWhitespace();
    }
    if (!this.startsWith('?>')) throw malformed();
    this.i += 2;
    this.column += 2;
  }

  private readAttributeValue(quote: number): string {
    const parts: string[] = [];
    for (;;) {
      if (this.eof) throw malformed();
      const cp = this.peek();
      if (cp === quote) {
        this.step();
        return parts.join('');
      }
      if (cp === 0x3c) throw malformed(); // '<' in an attribute value
      if (cp === 0x26) {
        parts.push(this.parseReference());
        continue;
      }
      this.step();
      if (!isValidXmlChar(cp)) throw malformed();
      // CDATA-type attribute-value normalization: literal tab and
      // newline become a space (line endings are already LF after
      // the input normalization); character references are literal.
      parts.push(cp === 0x9 || cp === 0xa ? ' ' : String.fromCodePoint(cp));
    }
  }

  private parseTextRun(): void {
    for (;;) {
      if (this.eof || this.peek() === 0x3c) return; // '<' or end
      if (this.startsWith(']]>')) throw malformed();
      const cp = this.peek();
      if (cp === 0x26) {
        this.parseReference(); // validity only; text is not retained
        continue;
      }
      this.step();
      if (!isValidXmlChar(cp)) throw malformed();
    }
  }

  private parseElement(parent: RawElement | null): RawElement {
    const line = this.line;
    const column = this.column;
    this.step(); // '<'
    const qname = this.readName();
    if (qname === '') throw malformed();
    const attrs: Array<[string, string]> = [];
    const seen = new Set<string>();
    let empty = false;
    for (;;) {
      const hadWhitespace = this.skipWhitespace();
      if (this.eof) throw malformed();
      if (this.startsWith('/>')) {
        this.i += 2;
        this.column += 2;
        empty = true;
        break;
      }
      if (this.peek() === 0x3e) {
        // '>'
        this.step();
        break;
      }
      if (!hadWhitespace) throw malformed();
      const name = this.readName();
      if (name === '') throw malformed();
      if (seen.has(name)) throw malformed(); // duplicate attribute
      seen.add(name);
      this.skipWhitespace();
      if (this.peek() !== 0x3d) throw malformed(); // '='
      this.step();
      this.skipWhitespace();
      const quote = this.peek();
      if (quote !== 0x22 && quote !== 0x27) throw malformed();
      this.step();
      attrs.push([name, this.readAttributeValue(quote)]);
    }
    // The Core's expat start-element handler: limits are checked
    // when the start tag completes, before any content is read.
    this.count += 1;
    this.depth += 1;
    if (this.count > MAX_ELEMENTS || this.depth > MAX_DEPTH) {
      throw new TsCoreError(
        'resource-limit',
        'XML exceeds 5000 elements or depth 32',
      );
    }
    for (const [, value] of attrs) {
      if ([...value].length > MAX_ATTRIBUTE_CODE_POINTS) {
        throw new TsCoreError(
          'resource-limit',
          'XML attribute exceeds 100,000 code points',
        );
      }
    }
    const node: RawElement = {
      qname,
      attrs,
      children: [],
      parent,
      line,
      column,
    };
    if (empty) {
      this.depth -= 1;
      return node;
    }
    for (;;) {
      if (this.eof) throw malformed(); // unclosed element
      if (this.startsWith('</')) {
        this.i += 2;
        this.column += 2;
        const name = this.readName();
        this.skipWhitespace();
        if (this.peek() !== 0x3e) throw malformed();
        this.step();
        if (name !== qname) throw malformed();
        this.depth -= 1;
        return node;
      }
      if (this.startsWith('<!--')) {
        this.parseComment();
        continue;
      }
      if (this.startsWith('<![CDATA[')) {
        this.parseCdata();
        continue;
      }
      if (this.startsWith('<!DOCTYPE')) {
        this.parseDoctype();
        continue;
      }
      if (this.startsWith('<!')) throw malformed();
      if (this.startsWith('<?')) {
        this.parseProcessingInstruction();
        continue;
      }
      if (this.peek() === 0x3c) {
        node.children.push(this.parseElement(node));
        continue;
      }
      this.parseTextRun();
    }
  }

  /** Prolog/epilog material: whitespace, comments; PIs and DOCTYPE act. Returns at an element or EOF. */
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
      if (this.startsWith('<!')) throw malformed();
      if (this.peek() === 0x3c) return;
      throw malformed();
    }
  }

  parseDocument(): RawElement {
    // A leading U+FEFF is the decoded UTF-8 BOM: expat steps over
    // it as the signature but still counts it in the column (the
    // Core's recorded root position with a BOM is column 1).
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
    if (this.eof) throw malformed(); // no root element
    const root = this.parseElement(null);
    this.parseMisc();
    if (!this.eof) throw malformed(); // content after the root element
    return root;
  }
}

function resolveQualifiedName(
  qname: string,
  scope: Map<string, string>,
  isAttribute: boolean,
): { ns: string | null; local: string } {
  const colon = qname.indexOf(':');
  if (colon === -1) {
    if (isAttribute) return { ns: null, local: qname };
    const uri = scope.get('');
    return { ns: uri ? uri : null, local: qname };
  }
  const prefix = qname.slice(0, colon);
  const local = qname.slice(colon + 1);
  if (local === '' || local.includes(':')) throw malformed();
  if (prefix === 'xmlns') throw malformed();
  if (prefix === 'xml') return { ns: XML_NS, local };
  const uri = scope.get(prefix);
  if (!uri) throw malformed(); // unbound prefix
  return { ns: uri, local };
}

function expandNamespaces(
  raw: RawElement,
  inherited: Map<string, string>,
  parent: XmlElement | null,
): XmlElement {
  const scope = new Map(inherited);
  for (const [name, value] of raw.attrs) {
    if (name === 'xmlns') {
      scope.set('', value);
    } else if (name.startsWith('xmlns:')) {
      const prefix = name.slice(6);
      if (prefix === 'xmlns' || prefix === '') throw malformed();
      if (prefix === 'xml') {
        if (value !== XML_NS) throw malformed();
      } else {
        if (value === '') throw malformed();
        scope.set(prefix, value);
      }
    }
  }
  const { ns, local } = resolveQualifiedName(raw.qname, scope, false);
  const node: XmlElement = {
    ns,
    local,
    attrs: [],
    children: [],
    parent,
    line: raw.line,
    column: raw.column,
  };
  const expanded = new Set<string>();
  for (const [name, value] of raw.attrs) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const resolved = resolveQualifiedName(name, scope, true);
    const key = etName(resolved.ns, resolved.local);
    if (expanded.has(key)) throw malformed(); // duplicate expanded attribute
    expanded.add(key);
    node.attrs.push({ ns: resolved.ns, local: resolved.local, value });
  }
  for (const child of raw.children) {
    node.children.push(expandNamespaces(child, scope, node));
  }
  return node;
}

/**
 * Mirror of the Core's parse_source: validate the source's size,
 * encoding and XML under the Core's limits and prohibitions, and
 * return the decoded text with the namespace-expanded tree. Throws
 * TsCoreError with the Core's codes ('resource-limit' /
 * 'invalid-svg') and messages.
 */
export function parseSource(source: Uint8Array): {
  text: string;
  root: XmlElement;
} {
  if (source.length > MAX_SVG) {
    throw new TsCoreError('resource-limit', 'SVG exceeds 1,000,000 bytes');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      source,
    );
  } catch {
    throw new TsCoreError('invalid-svg', 'SVG is not UTF-8');
  }
  if (text.includes('\x00')) {
    throw new TsCoreError('invalid-svg', 'NUL is forbidden in SVG');
  }
  const raw = new Parser(text).parseDocument();
  const root = expandNamespaces(raw, new Map(), null);
  if (etName(root.ns, root.local) !== `{${SVG_NS}}svg`) {
    throw new TsCoreError(
      'invalid-svg',
      'Root must be SVG in the SVG namespace',
    );
  }
  return { text, root };
}
