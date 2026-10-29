// Host system fonts for the TypeScript Core renderer (Issue #58).
//
// Interim font strategy, pending the Issue #61 decision: editor
// rendering uses host system fonts, matching the previous Cairo
// path's host-selected behaviour. The renderer itself takes raw
// buffers and reads each font's real family from the font data, so
// this module's job is only to choose candidate files: the common
// sans families (plus a CJK family when present) from the platform's
// font directories, identified by the file names those families
// ship under. Buffers are loaded ONCE per extension activation and
// cached as bytes - file reads never repeat per render. (resvg
// still ingests the buffers on each renderer construction; that
// cost is measured and reported with the Issue #58 integration.)
import { readdir, stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { loadFontBuffers, type FontBuffer } from '../../ts-core/src/fonts.ts';

export interface HostFonts {
  fonts: FontBuffer[];
  /** Family resvg should treat as the default / sans-serif family. */
  defaultFamily: string;
  /** The files the buffers came from, in load order. */
  files: string[];
}

interface FamilyRule {
  family: string;
  /** Basename pattern (case-insensitive) for one face of the family. */
  pattern: RegExp;
  weight: number;
}

// Ordered by preference: when several families are present the
// earlier rules load first, and the default family prefers the
// earliest loaded one from DEFAULT_PREFERENCE below.
const FAMILY_RULES: FamilyRule[] = [
  { family: 'Noto Sans', pattern: /^notosans-regular\.(ttf|otf)$/i, weight: 400 },
  { family: 'Noto Sans', pattern: /^notosans-bold\.(ttf|otf)$/i, weight: 700 },
  { family: 'Noto Sans', pattern: /^notosans-italic\.(ttf|otf)$/i, weight: 400 },
  { family: 'Noto Sans', pattern: /^notosans-bolditalic\.(ttf|otf)$/i, weight: 700 },
  { family: 'Noto Sans CJK JP', pattern: /^notosanscjk-(regular|jp-regular)\.ttc$/i, weight: 400 },
  { family: 'Noto Sans CJK JP', pattern: /^notosanscjk-(bold|jp-bold)\.ttc$/i, weight: 700 },
  { family: 'Noto Sans JP', pattern: /^notosansjp-regular\.(ttf|otf)$/i, weight: 400 },
  { family: 'Noto Sans JP', pattern: /^notosansjp-bold\.(ttf|otf)$/i, weight: 700 },
  { family: 'Arial', pattern: /^arial\.ttf$/i, weight: 400 },
  { family: 'Arial', pattern: /^arialbd\.ttf$/i, weight: 700 },
  { family: 'Arial', pattern: /^ariali\.ttf$/i, weight: 400 },
  { family: 'Arial', pattern: /^arialbi\.ttf$/i, weight: 700 },
  { family: 'Liberation Sans', pattern: /^liberationsans-regular\.ttf$/i, weight: 400 },
  { family: 'Liberation Sans', pattern: /^liberationsans-bold\.ttf$/i, weight: 700 },
  { family: 'Liberation Sans', pattern: /^liberationsans-italic\.ttf$/i, weight: 400 },
  { family: 'Liberation Sans', pattern: /^liberationsans-bolditalic\.ttf$/i, weight: 700 },
  { family: 'Segoe UI', pattern: /^segoeui\.ttf$/i, weight: 400 },
  { family: 'Segoe UI', pattern: /^segoeuib\.ttf$/i, weight: 700 },
  { family: 'Segoe UI', pattern: /^segoeuii\.ttf$/i, weight: 400 },
  { family: 'Segoe UI', pattern: /^segoeuiz\.ttf$/i, weight: 700 },
  { family: 'Yu Gothic', pattern: /^yugothr\.ttc$/i, weight: 400 },
  { family: 'Yu Gothic', pattern: /^yugothb\.ttc$/i, weight: 700 },
  { family: 'Meiryo', pattern: /^meiryo\.ttc$/i, weight: 400 },
  { family: 'Meiryo', pattern: /^meiryob\.ttc$/i, weight: 700 },
  { family: 'MS Gothic', pattern: /^msgothic\.ttc$/i, weight: 400 },
  { family: 'Hiragino Sans', pattern: /^hiragino.*\.(ttc|otf)$/i, weight: 400 },
  { family: 'Helvetica', pattern: /^helvetica\.(ttc|ttf)$/i, weight: 400 },
  { family: 'DejaVu Sans', pattern: /^dejavusans\.ttf$/i, weight: 400 },
  { family: 'DejaVu Sans', pattern: /^dejavusans-bold\.ttf$/i, weight: 700 },
  { family: 'DejaVu Sans', pattern: /^dejavusans-oblique\.ttf$/i, weight: 400 },
  { family: 'DejaVu Sans', pattern: /^dejavusans-boldoblique\.ttf$/i, weight: 700 },
];

const DEFAULT_PREFERENCE = [
  'Noto Sans', 'Arial', 'Liberation Sans', 'Segoe UI', 'Helvetica', 'DejaVu Sans',
];

const FONT_EXTENSIONS = /\.(ttf|otf|ttc)$/i;
const MAX_FONT_FILES = 40;
const MAX_FONT_BYTES = 96_000_000;
const MAX_DEPTH = 4;

/** The platform's font directories, most specific last. */
export function fontDirectories(
  platform: NodeJS.Platform = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/System/Library/Fonts',
        '/System/Library/Fonts/Supplemental',
        '/Library/Fonts',
        join(home, 'Library', 'Fonts'),
      ];
    case 'win32': {
      const windir = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
      const dirs = [join(windir, 'Fonts')];
      if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
      return dirs;
    }
    default:
      return [
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        join(home, '.fonts'),
        join(home, '.local', 'share', 'fonts'),
      ];
  }
}

interface Candidate { path: string; family: string; weight: number; rule: number }

/**
 * Choose the font files to load from the given directories: every
 * file a family rule claims, in rule order (then path order), capped
 * so a pathological font directory cannot exhaust memory. When no
 * rule matches anything, falls back to the first font files found
 * (resvg reads their families from the data) so an unusual system
 * still renders text.
 */
export async function collectFontFiles(directories: string[]): Promise<Candidate[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // An unreadable/absent font directory is not an error.
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1);
      } else if (entry.isFile() && FONT_EXTENSIONS.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const dir of directories) await walk(dir, 0);
  found.sort();

  const claimed: Candidate[] = [];
  const used = new Set<string>();
  FAMILY_RULES.forEach((rule, index) => {
    for (const path of found) {
      const base = path.split(/[\\/]/).pop() ?? path;
      if (!used.has(path) && rule.pattern.test(base)) {
        used.add(path);
        claimed.push({ path, family: rule.family, weight: rule.weight, rule: index });
      }
    }
  });
  const selected = claimed.length > 0
    ? claimed
    : found.map((path) => ({ path, family: '', weight: 400, rule: FAMILY_RULES.length }));

  const capped: Candidate[] = [];
  let bytes = 0;
  for (const candidate of selected) {
    if (capped.length >= MAX_FONT_FILES) break;
    let size = 0;
    try {
      size = (await stat(candidate.path)).size;
    } catch {
      continue;
    }
    if (bytes + size > MAX_FONT_BYTES && capped.length > 0) continue;
    bytes += size;
    capped.push(candidate);
  }
  return capped;
}

async function loadHostFontsUncached(): Promise<HostFonts> {
  const candidates = await collectFontFiles(fontDirectories());
  const fonts = await loadFontBuffers(
    candidates.map((c) => ({ path: c.path, family: c.family || undefined, weight: c.weight })),
  );
  const loadedFamilies = candidates.map((c) => c.family).filter((f) => f !== '');
  const defaultFamily = DEFAULT_PREFERENCE.find((family) => loadedFamilies.includes(family))
    ?? loadedFamilies[0]
    ?? 'Noto Sans';
  return { fonts, defaultFamily, files: candidates.map((c) => c.path) };
}

let cached: Promise<HostFonts> | undefined;

/**
 * The process-wide host font set, loaded at most once. Callers share
 * the same buffers for every render in the activation.
 */
export function loadHostFonts(): Promise<HostFonts> {
  cached ??= loadHostFontsUncached();
  return cached;
}
