// Extension-side glue to the bridge managed-environment manager
// (P1-04 manager, P2-07 integration). The manager owns the store
// layout, locking, health checks and atomic activation; this module
// only decides which Python the editor uses and where the trusted
// Core artifacts come from.
//
// Precedence: an explicit `vectorPng.corePythonPath` setting always
// wins; otherwise the managed environment's active interpreter;
// otherwise none (edited previews/saves report unavailable, the saved
// preview keeps working).
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { activeEnvironment } from '../../bridge/src/environment.ts';

export function pickPython(configured: string | undefined, managed: string | undefined): string | undefined {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : managed;
}

export async function managedPython(root: string): Promise<string | undefined> {
  try {
    const active = await activeEnvironment(root);
    return active?.python;
  } catch {
    return undefined; // Corrupt store state fails closed, never guesses.
  }
}

export async function resolveCorePython(root: string, configured: string | undefined): Promise<string | undefined> {
  return pickPython(configured, configured?.trim() ? undefined : await managedPython(root));
}

export type CoreArtifacts = {
  wheel: string; wheelSha256: string; version: string;
  requirements: string; requirementsSha256: string; source: string;
};

const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

// Trusted artifact sources, in order: an explicit wheel path from
// settings; the extension's bundled `managed/` directory (populated
// at VSIX packaging time); a sibling repository checkout's built
// wheel (development). Digests are computed from the located files
// and re-verified by the manager against its snapshots.
export async function locateCoreArtifacts(options: {
  extensionDir: string; wheelSetting?: string;
}): Promise<CoreArtifacts | undefined> {
  const candidates: { wheelDir: string; requirements: string; source: string }[] = [];
  if (options.wheelSetting?.trim()) {
    candidates.push({ wheelDir: '', requirements: join(options.extensionDir, 'managed', 'requirements.lock'), source: 'setting' });
  }
  candidates.push({ wheelDir: join(options.extensionDir, 'managed'), requirements: join(options.extensionDir, 'managed', 'requirements.lock'), source: 'bundled' });
  candidates.push({ wheelDir: join(options.extensionDir, '..', '..', 'packages', 'core', 'dist'), requirements: join(options.extensionDir, '..', '..', 'requirements.lock'), source: 'sibling checkout' });
  for (const candidate of candidates) {
    let wheel: string | undefined;
    if (candidate.source === 'setting') {
      wheel = options.wheelSetting!.trim();
    } else {
      const names = await readdir(candidate.wheelDir).catch(() => [] as string[]);
      const found = names.filter((n) => n.startsWith('vector_png_editor_core-') && n.endsWith('-py3-none-any.whl')).sort();
      if (found.length) wheel = join(candidate.wheelDir, found[found.length - 1]);
    }
    if (!wheel) continue;
    const version = /vector_png_editor_core-([0-9]+\.[0-9]+\.[0-9]+(?:\.dev[0-9]+)?)-/.exec(wheel)?.[1];
    if (!version) continue;
    try {
      const [wheelSha256, requirementsSha256] = await Promise.all([sha256(wheel), sha256(candidate.requirements)]);
      return { wheel, wheelSha256, version, requirements: candidate.requirements, requirementsSha256, source: candidate.source };
    } catch { continue; }
  }
  return undefined;
}
