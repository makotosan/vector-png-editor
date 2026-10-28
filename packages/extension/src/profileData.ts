// Consumption of the generated safe-svg-v1 Monaco metadata
// (schemas/safe-svg-v1.monaco.json, generated from the policy by
// tools/generate_safe_svg_schemas.py - Issue #22 Phase 2). The editor's
// completion is driven by this data so the Skill, the CLI validator
// and the editor all present the same profile version. Parsing is
// strict: a malformed or foreign profile is rejected, never guessed.
export type SchemaProfile = {
  profile: string;
  version: string;
  elements: string[];
  attributes: string[];
  children: Record<string, string[]>;
  textElements: string[];
};

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw new Error(`safe-svg profile: ${what} must be an array of strings`);
  return [...value];
}

export function parseSchemaProfile(text: string): SchemaProfile {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data.profile !== 'safe-svg-v1')
    throw new Error(`safe-svg profile: unexpected profile ${String(data.profile)}`);
  if (typeof data.version !== 'string' || !data.version)
    throw new Error('safe-svg profile: missing version');
  if (!Array.isArray(data.elements) || data.elements.length === 0)
    throw new Error('safe-svg profile: elements missing');
  const elements: string[] = [];
  const children: Record<string, string[]> = {};
  const textElements: string[] = [];
  const names = new Set<string>();
  for (const entry of data.elements as Record<string, unknown>[]) {
    if (typeof entry?.name !== 'string' || !entry.name)
      throw new Error('safe-svg profile: element without a name');
    if (names.has(entry.name)) throw new Error(`safe-svg profile: duplicate element ${entry.name}`);
    names.add(entry.name);
    elements.push(entry.name);
    children[entry.name] = stringArray(entry.children ?? [], `children of ${entry.name}`);
    if (entry.textContent === true) textElements.push(entry.name);
  }
  for (const [parent, kids] of Object.entries(children))
    for (const kid of kids)
      if (!names.has(kid)) throw new Error(`safe-svg profile: ${parent} lists unknown child ${kid}`);
  const attributes = stringArray(data.attributes, 'attributes');
  return { profile: 'safe-svg-v1', version: data.version, elements, attributes, children, textElements };
}

export function childrenFor(profile: SchemaProfile, parent: string | null): string[] {
  if (parent === null) return profile.elements;
  return profile.children[parent] ?? profile.elements;
}
