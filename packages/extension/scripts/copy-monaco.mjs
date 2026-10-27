// Copies the pinned monaco-editor package's minified VS assets into
// media/monaco so the webview loads Monaco only from the packaged
// extension - never from a CDN. media/monaco is generated, not committed.
import { cp, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const target = join(root, 'media', 'monaco', 'vs');
try {
  await access(source);
} catch {
  console.error('monaco-editor is not installed; run npm install first');
  process.exit(1);
}
await rm(join(root, 'media', 'monaco'), { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Copied Monaco assets to ${target}`);
