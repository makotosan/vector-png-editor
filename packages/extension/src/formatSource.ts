// Conservative source formatting for the code toolbar's Format
// action (Issue #45). The formatter only ever rewrites the leading
// indentation of structural lines to match the element nesting; it
// never joins or splits lines, never rewrites text content, and
// leaves the content of raw-text elements (<style>, <text>, <tspan>),
// comments and CDATA sections byte-for-byte untouched. Formatting is
// an ordinary edit like any other: when the output equals the input
// the caller makes no edit at all.

const RAW_ELEMENTS = new Set(['style', 'text', 'tspan']);
const INDENT = '  ';

type TagKind = 'open' | 'close' | 'selfclose' | 'other';

type PendingTag = { name: string | null; kind: 'open' | 'close'; quote: string | null };

type ScanState = {
  depth: number;
  raw: string | null;
  comment: boolean;
  cdata: boolean;
  pending: PendingTag | null;
};

type SegmentResult = { firstKind: TagKind | null; net: number };

// Finds the '>' ending a tag that starts before `from`, respecting
// quoted attribute values. Returns the index of '>' and the quote
// still open at the end of the text, if any.
function findTagEnd(text: string, from: number, quote: string | null): { end: number; quote: string | null } {
  let open = quote;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (open) { if (c === open) open = null; }
    else if (c === '"' || c === "'") open = c;
    else if (c === '>') return { end: j, quote: null };
  }
  return { end: -1, quote: open };
}

// Scans one segment of text in normal mode, updating the carried
// state (comment/CDATA/raw/pending transitions) and reporting the
// first tag kind and the net depth change of the completed tags.
function scanSegment(text: string, state: ScanState): SegmentResult {
  let firstKind: TagKind | null = null;
  let net = 0;
  const note = (kind: TagKind) => { if (firstKind === null) firstKind = kind; };
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      note('other');
      const end = text.indexOf('-->', i + 4);
      if (end === -1) { state.comment = true; return { firstKind, net }; }
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      note('other');
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) { state.cdata = true; return { firstKind, net }; }
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      note('other');
      const end = text.indexOf('?>', i + 2);
      if (end === -1) return { firstKind, net };
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      note('other');
      const end = text.indexOf('>', i + 2);
      if (end === -1) return { firstKind, net };
      i = end + 1;
      continue;
    }
    const isClose = text.startsWith('</', i);
    const nameMatch = /^[A-Za-z][A-Za-z0-9_.:-]*/.exec(text.slice(i + (isClose ? 2 : 1)));
    if (!nameMatch) { i += 1; continue; }
    const name = nameMatch[0];
    const afterName = i + (isClose ? 2 : 1) + name.length;
    const { end, quote } = findTagEnd(text, afterName, null);
    if (end === -1) {
      note(isClose ? 'close' : 'open');
      state.pending = { name, kind: isClose ? 'close' : 'open', quote };
      return { firstKind, net };
    }
    const selfClosing = !isClose && text[end - 1] === '/';
    if (isClose) { note('close'); net -= 1; i = end + 1; continue; }
    if (selfClosing) { note('selfclose'); i = end + 1; continue; }
    note('open');
    net += 1;
    i = end + 1;
    if (RAW_ELEMENTS.has(name)) {
      // Raw content runs to the matching close tag; when it is on
      // the same line the pair is balanced and scanning continues.
      const closeMatch = new RegExp(`</${name}\\s*>`).exec(text.slice(i));
      if (closeMatch) {
        net -= 1;
        i += closeMatch.index + closeMatch[0].length;
      } else {
        state.raw = name;
        return { firstKind, net };
      }
    }
  }
  return { firstKind, net };
}

// Completes a tag left open by a previous line. The completion's net
// depth change is folded into `net`; any remainder after the tag is
// scanned as a normal segment.
function completePending(text: string, state: ScanState): SegmentResult {
  const pending = state.pending as PendingTag;
  const { end, quote } = findTagEnd(text, 0, pending.quote);
  if (end === -1) {
    pending.quote = quote;
    return { firstKind: null, net: 0 };
  }
  state.pending = null;
  const selfClosing = pending.kind === 'open' && text[end - 1] === '/';
  let net = pending.kind === 'close' ? -1 : selfClosing ? 0 : 1;
  if (pending.kind === 'open' && !selfClosing && pending.name && RAW_ELEMENTS.has(pending.name)) {
    const rest = text.slice(end + 1);
    const closeMatch = new RegExp(`</${pending.name}\\s*>`).exec(rest);
    if (!closeMatch) {
      state.raw = pending.name;
      return { firstKind: null, net };
    }
    net -= 1;
    const tail = scanSegment(rest.slice(closeMatch.index + closeMatch[0].length), state);
    return { firstKind: null, net: net + tail.net };
  }
  const tail = scanSegment(text.slice(end + 1), state);
  return { firstKind: null, net: net + tail.net };
}

export function formatSvgSource(source: string): string {
  const state: ScanState = { depth: 0, raw: null, comment: false, cdata: false, pending: null };
  const lines = source.split('\n');
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // Inside a comment, CDATA section or raw-text element the line
    // is content, never structure: emit it exactly as authored and
    // only watch for the terminator.
    if (state.comment || state.cdata || state.raw) {
      out.push(line);
      if (state.comment && line.includes('-->')) state.comment = false;
      else if (state.cdata && line.includes(']]>')) state.cdata = false;
      else if (state.raw && new RegExp(`</${state.raw}\\s*>`).test(line)) {
        state.raw = null;
        state.depth = Math.max(0, state.depth - 1);
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '') { out.push(''); continue; }
    if (state.pending) {
      const { net } = completePending(trimmed, state);
      out.push(INDENT.repeat(state.depth + 1) + trimmed);
      state.depth = Math.max(0, state.depth + net);
      continue;
    }
    const { firstKind, net } = scanSegment(trimmed, state);
    const lineDepth = Math.max(0, state.depth - (firstKind === 'close' ? 1 : 0));
    out.push(INDENT.repeat(lineDepth) + trimmed);
    state.depth = Math.max(0, state.depth + net);
  }
  return out.join('\n');
}
