import { SAFE_SVG_ATTRIBUTES, SAFE_SVG_ELEMENTS, MAX_ELEMENTS } from './profile.ts';

// Advisory safe-svg-v1 diagnostics computed by scanning source text.
// This is a text scan, not an XML parse and never a DOM: hostile markup is
// treated as characters. The Core validator stays authoritative;
// these diagnostics only guide editing (completion/search feedback loop).
export type Diagnostic = {
  code: 'unsupported-element' | 'unsupported-attribute' | 'forbidden-construct' | 'external-reference' | 'too-many-elements';
  message: string;
  offset: number;
  length: number;
};

const elements = new Set(SAFE_SVG_ELEMENTS);
const attributes = new Set(SAFE_SVG_ATTRIBUTES);
// Namespace declarations appear in the source text but are not XML
// attributes in the Core's model, so they are exempt from the allowlist.
const structural = new Set(['xmlns', 'xmlns:xlink']);

export function diagnoseSource(source: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    const at = source.search(/<!DOCTYPE|<!ENTITY/i);
    out.push({ code: 'forbidden-construct', message: 'DTD and entity declarations are forbidden in safe-svg-v1', offset: at, length: 2 });
  }
  const tagPattern = /<(\/?)([A-Za-z][A-Za-z0-9._-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/g;
  let count = 0;
  for (const match of source.matchAll(tagPattern)) {
    const [, closing, name, attrText] = match;
    if (!elements.has(name)) {
      out.push({ code: 'unsupported-element', message: `Element <${name}> is not in safe-svg-v1`, offset: match.index + 1 + closing.length, length: name.length });
      continue;
    }
    if (!closing) {
      count++;
      if (count === MAX_ELEMENTS + 1)
        out.push({ code: 'too-many-elements', message: `safe-svg-v1 allows at most ${MAX_ELEMENTS} elements`, offset: match.index, length: name.length });
    }
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    for (const attr of attrText.matchAll(attrPattern)) {
      const attrName = attr[1];
      const attrValue = attr[2] ?? attr[3] ?? '';
      if (structural.has(attrName)) continue; // namespace URLs are identifiers, not fetches
      if (!attributes.has(attrName) && !structural.has(attrName)) {
        out.push({ code: 'unsupported-attribute', message: `Attribute ${attrName} is not in safe-svg-v1`, offset: match.index + match[0].indexOf(attrName), length: attrName.length });
        continue;
      }
      if (/url\s*\(/i.test(attrValue) && !/^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/.test(attrValue.trim()))
        out.push({ code: 'external-reference', message: 'Only local fragment references url(#id) are allowed', offset: match.index, length: match[0].length });
      else if (/https?:\/\//i.test(attrValue))
        out.push({ code: 'external-reference', message: 'External references are not allowed in safe-svg-v1', offset: match.index, length: match[0].length });
    }
  }
  return out;
}

export function lineCol(source: string, offset: number): { line: number; column: number } {
  const upto = source.slice(0, offset);
  const line = (upto.match(/\n/g) ?? []).length;
  const column = offset - (upto.lastIndexOf('\n') + 1);
  return { line, column };
}
