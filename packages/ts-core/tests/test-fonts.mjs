// Loads the Issue #57 spike's font set through the package's own
// ingestion path (src/fonts.ts), skipping any file this machine
// does not have. The spike used these eight files: Noto Sans and
// Noto Sans CJK JP (the fontconfig sans-serif matches), plus
// Liberation Sans and DejaVu Sans as additional sans candidates.
import { access } from 'node:fs/promises';
import { loadFontBuffers } from '../src/fonts.ts';

export const SPIKE_FONT_FILES = [
  { path: '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', family: 'Noto Sans', weight: 400 },
  { path: '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf', family: 'Noto Sans', weight: 700 },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK JP', weight: 400 },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', family: 'Noto Sans CJK JP', weight: 700 },
  { path: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', family: 'Liberation Sans', weight: 400 },
  { path: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', family: 'Liberation Sans', weight: 700 },
  { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', family: 'DejaVu Sans', weight: 400 },
  { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', family: 'DejaVu Sans', weight: 700 },
];

let cached;
export function loadSpikeFonts() {
  cached ??= (async () => {
    const present = [];
    for (const spec of SPIKE_FONT_FILES) {
      try {
        await access(spec.path);
        present.push(spec);
      } catch {
        // Machine lacks this family; rendering proceeds with the rest.
      }
    }
    return loadFontBuffers(present);
  })();
  return cached;
}
