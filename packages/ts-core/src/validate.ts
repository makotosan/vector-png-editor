// safe-svg-v1 validation, mirroring the Python Core's acceptance
// verdict and its structured diagnostics:
//
// - validateSource is the Core's svg.validate_source: the source is
//   parsed under the Core's limits (xml.ts) and then accepted or
//   rejected by the allowlist/reference rules of
//   _backend.validate_svg. A profile rejection throws
//   TsCoreError('unsupported-profile') carrying the backend's first
//   error message verbatim, as the Core wraps it.
//
// - checkProfile is the Core's profile_check.check_profile: the
//   same rules, but every violation is collected as a diagnostic
//   {severity, code, element, attribute, line, column, message,
//   suggestion} (at most 50), optionally with the generated
//   schema's content models enforced (strictStructure). XML-level
//   failures throw exactly as validateSource's parse does.
//
// Deliberately NOT here: canonical serialization. The Core's
// validation path reserializes nothing (rendering.py: "no source
// reserialization"); build embeds the source bytes as supplied.
// The only canonicalizer in the Core is the normalizer, which is a
// separate port.
import { TsCoreError } from './errors.ts';
import { etName, parseSource, profileName, type XmlElement } from './xml.ts';

export const TAGS = new Set(
  'svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath'.split(
    ' ',
  ),
);

export const ATTRS = new Set(
  'id x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity font-family font-size font-weight font-style letter-spacing text-anchor dominant-baseline dx dy rotate offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clip-path clipPathUnits'.split(
    ' ',
  ),
);

const FRAGMENT = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/;
const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const URL_ATTRIBUTES = new Set(['fill', 'stroke', 'clip-path']);
const DEFINITION_ELEMENTS = new Set([
  'clipPath',
  'linearGradient',
  'radialGradient',
]);

function fragmentId(value: string): string | null {
  const match = FRAGMENT.exec(value);
  return match && match[0].length === value.length ? value.slice(5, -1) : null;
}

function hasForbiddenValueSyntax(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (
      ch === '\\' || ch === '@' || ch === '{' || ch === '}' ||
      ch === ';' || ch === '<' || ch === '>' || ch === '\x00'
    ) {
      return true;
    }
    if (cp < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r') return true;
  }
  return false;
}

class ProfileRejection extends Error {}

/**
 * _backend.validate_svg over the parsed tree: throws ProfileRejection
 * with the backend's message for the first violation, in the
 * backend's own traversal order (iterative stack DFS, children
 * pushed in document order and therefore visited in reverse).
 */
function validateSvgTree(root: XmlElement): void {
  const ids = new Map<string, string>();
  const refs: Array<[string, string]> = [];
  const stack: Array<[XmlElement, number]> = [[root, 0]];
  let count = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    count += 1;
    if (count > 5000 || depth > 32) {
      throw new ProfileRejection('SVG complexity limit exceeded');
    }
    if (node.ns !== 'http://www.w3.org/2000/svg' || !TAGS.has(node.local)) {
      throw new ProfileRejection(
        `Unsupported SVG element: ${etName(node.ns, node.local)}`,
      );
    }
    for (const attr of node.attrs) {
      const name = etName(attr.ns, attr.local);
      if (!ATTRS.has(name) || [...attr.value].length > 100_000) {
        throw new ProfileRejection(`Unsupported SVG attribute: ${name}`);
      }
      // CSS escapes, declarations and non-ASCII controls cannot hide
      // resource URLs.
      if (hasForbiddenValueSyntax(attr.value)) {
        throw new ProfileRejection('Unsupported attribute syntax');
      }
      if (attr.value.toLowerCase().includes('url')) {
        const ref = fragmentId(attr.value);
        if (!URL_ATTRIBUTES.has(name) || ref === null) {
          throw new ProfileRejection(
            'Only local paint/clip URLs are supported',
          );
        }
        refs.push([name, ref]);
      }
      if (name === 'id') {
        if (!ID_PATTERN.test(attr.value) || ids.has(attr.value)) {
          throw new ProfileRejection('Invalid or duplicate SVG id');
        }
        ids.set(attr.value, node.local);
      }
    }
    for (const child of node.children) stack.push([child, depth + 1]);
  }
  for (const [name, ref] of refs) {
    const expected =
      name === 'clip-path'
        ? new Set(['clipPath'])
        : new Set(['linearGradient', 'radialGradient']);
    if (!expected.has(ids.get(ref)!)) {
      throw new ProfileRejection('Invalid local resource reference');
    }
  }
  // Disallow references from definitions, preventing recursive
  // clips/paint servers.
  for (const node of preorder(root)) {
    if (DEFINITION_ELEMENTS.has(node.local)) {
      for (const inner of preorder(node)) {
        for (const attr of inner.attrs) {
          if (attr.value.toLowerCase().includes('url')) {
            throw new ProfileRejection(
              'References inside resource definitions are unsupported',
            );
          }
        }
      }
    }
  }
}

function* preorder(root: XmlElement): Generator<XmlElement> {
  yield root;
  for (const child of root.children) yield* preorder(child);
}

export interface ValidateReport {
  xml: 'valid';
  profile: 'safe-svg-v1';
  profile_check: 'passed';
  render: 'not-checked';
  svg_bytes: number;
}

/**
 * Mirror of the Core's validate_source: XML and safe-svg-v1
 * allowlist only; no rendering and no numeric validation.
 */
export function validateSource(source: Uint8Array): ValidateReport {
  const { root } = parseSource(source);
  try {
    validateSvgTree(root);
  } catch (error) {
    if (error instanceof ProfileRejection) {
      throw new TsCoreError('unsupported-profile', error.message);
    }
    throw error;
  }
  return {
    xml: 'valid',
    profile: 'safe-svg-v1',
    profile_check: 'passed',
    render: 'not-checked',
    svg_bytes: source.length,
  };
}

export interface Diagnostic {
  severity: 'error';
  code: string;
  element: string | null;
  attribute: string | null;
  line: number | null;
  column: number | null;
  message: string;
  suggestion: string | null;
}

const MAX_DIAGNOSTICS = 50;
const CONTAINERS = new Set([...TAGS].filter((tag) => tag !== 'stop'));
const CONTENT_MODELS: Record<string, Set<string>> = {
  svg: CONTAINERS,
  g: CONTAINERS,
  defs: CONTAINERS,
  clipPath: CONTAINERS,
  linearGradient: new Set(['stop', 'title', 'desc']),
  radialGradient: new Set(['stop', 'title', 'desc']),
  text: new Set(['tspan']),
  tspan: new Set(['tspan']),
  title: new Set(),
  desc: new Set(),
  stop: new Set(),
  path: new Set(),
  rect: new Set(),
  circle: new Set(),
  ellipse: new Set(),
  line: new Set(),
  polyline: new Set(),
  polygon: new Set(),
};

const SUGGESTIONS: Record<string, string> = {
  class:
    'class is not supported; set presentation attributes (fill, stroke, opacity, ...) directly on the element',
  style:
    'style is not supported; set presentation attributes directly on the element',
  href: 'hyperlinks and external references are not supported',
  'xlink:href': 'hyperlinks and external references are not supported',
  script: 'scripting is not supported; remove the element',
};

function suggestionFor(name: string): string | null {
  if (name in SUGGESTIONS) return SUGGESTIONS[name];
  if (name.startsWith('on')) {
    return 'event-handler attributes are not supported';
  }
  return null;
}

/**
 * Mirror of the Core's check_profile: structured safe-svg-v1
 * diagnostics (empty list = conforming). XML-level failures throw
 * TsCoreError from parseSource exactly as the Core reports them;
 * only profile-level violations become diagnostics.
 */
export function checkProfile(
  source: Uint8Array,
  options: { strictStructure?: boolean } = {},
): Diagnostic[] {
  const strictStructure = options.strictStructure ?? false;
  const { root } = parseSource(source);
  const diagnostics: Diagnostic[] = [];

  const add = (
    code: string,
    node: XmlElement | null,
    message: string,
    attribute: string | null = null,
    suggestion: string | null = null,
  ): void => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    diagnostics.push({
      severity: 'error',
      code,
      element: node ? node.local : null,
      attribute,
      line: node ? node.line : null,
      column: node ? node.column : null,
      message,
      suggestion: suggestion ?? suggestionFor(attribute ?? (node?.local ?? '')),
    });
  };

  const ids = new Map<string, XmlElement>();
  const refs: Array<[XmlElement, string, string]> = [];
  const order: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (let k = node.children.length - 1; k >= 0; k--) {
      stack.push(node.children[k]);
    }
  }
  for (const node of order) {
    const tag = node.local;
    if (node.ns !== 'http://www.w3.org/2000/svg' || !TAGS.has(tag)) {
      add(
        'unsupported-element',
        node,
        `Unsupported SVG element: ${profileName(node.ns, node.local)}`,
        null,
        suggestionFor(tag),
      );
      continue;
    }
    if (strictStructure && node.parent !== null) {
      const parentTag = node.parent.local;
      const model = CONTENT_MODELS[parentTag];
      if (model !== undefined && !model.has(tag)) {
        add(
          'structure',
          node,
          `<${tag}> is not allowed inside <${parentTag}> by the safe-svg-v1 content model`,
          null,
          `move <${tag}> out of <${parentTag}>, or remove it`,
        );
      }
    }
    let inDefinition = false;
    for (
      let ancestor: XmlElement | null = node;
      ancestor !== null;
      ancestor = ancestor.parent
    ) {
      if (DEFINITION_ELEMENTS.has(ancestor.local)) {
        inDefinition = true;
        break;
      }
    }
    for (const attr of node.attrs) {
      const name = profileName(attr.ns, attr.local);
      if (!ATTRS.has(name)) {
        add(
          'unsupported-attribute',
          node,
          `Unsupported SVG attribute: ${name}`,
          name,
        );
        continue;
      }
      if (hasForbiddenValueSyntaxProfile(attr.value)) {
        add(
          'forbidden-value',
          node,
          `Unsupported attribute syntax in ${name}`,
          name,
          'remove backslash, @, braces, semicolons, angle brackets and control characters',
        );
      }
      if (attr.value.toLowerCase().includes('url')) {
        const ref = fragmentId(attr.value);
        if (!URL_ATTRIBUTES.has(name) || ref === null) {
          add(
            'invalid-url',
            node,
            'Only local paint/clip URLs are supported',
            name,
            'use url(#id) pointing at a local gradient or clipPath',
          );
        } else {
          if (inDefinition) {
            add(
              'reference-in-definition',
              node,
              'References inside resource definitions are unsupported',
              name,
            );
          }
          refs.push([node, name, ref]);
        }
      }
      if (name === 'id') {
        if (!ID_PATTERN.test(attr.value)) {
          add(
            'invalid-id',
            node,
            `Invalid SVG id: ${attr.value}`,
            name,
            'ids must match [A-Za-z_][A-Za-z0-9_.-]*',
          );
        } else if (ids.has(attr.value)) {
          add(
            'duplicate-id',
            node,
            `Duplicate SVG id: ${attr.value}`,
            name,
          );
        } else {
          ids.set(attr.value, node);
        }
      }
    }
  }
  for (const [node, name, ref] of refs) {
    const expected =
      name === 'clip-path'
        ? new Set(['clipPath'])
        : new Set(['linearGradient', 'radialGradient']);
    const target = ids.get(ref);
    if (target === undefined) {
      add(
        'unresolved-reference',
        node,
        `Reference to missing id: ${ref}`,
        name,
        'define the referenced element with this id, or remove the reference',
      );
    } else if (!expected.has(target.local)) {
      add(
        'wrong-reference-type',
        node,
        `${name} must reference ${[...expected].sort().join(' or ')}, not <${target.local}>`,
        name,
      );
    }
  }
  return diagnostics;
}

// The profile layer's forbidden-value set omits NUL explicitly
// (control characters below 0x20 cover it), matching the Core,
// whose two layers spell the rule in two places.
function hasForbiddenValueSyntaxProfile(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (
      ch === '\\' || ch === '@' || ch === '{' || ch === '}' ||
      ch === ';' || ch === '<' || ch === '>'
    ) {
      return true;
    }
    if (cp < 32 && ch !== '\t' && ch !== '\n' && ch !== '\r') return true;
  }
  return false;
}
