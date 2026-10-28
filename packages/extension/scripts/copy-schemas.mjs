// Copies the generated safe-svg-v1 Monaco metadata into
// media/schemas so the packaged extension completes against the same
// profile data the CLI validator enforces (Issue #22 Phase 2).
// media/schemas is generated, not committed - like media/monaco.
import { cp, access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, '..', '..', 'schemas', 'safe-svg-v1.monaco.json');
const targetDir = join(root, 'media', 'schemas');
try {
  await access(source);
} catch {
  console.error('schemas/safe-svg-v1.monaco.json not found; generate it with tools/generate_safe_svg_schemas.py');
  process.exit(1);
}
await mkdir(targetDir, { recursive: true });
await cp(source, join(targetDir, 'safe-svg-v1.monaco.json'));
console.log(`Copied safe-svg-v1 Monaco metadata to ${targetDir}`);
