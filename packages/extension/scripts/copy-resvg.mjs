// Copies the resvg WASM binary into media/resvg so the packaged
// extension can initialise the TypeScript Core renderer without
// resolving the ts-core package's node_modules (Issue #58). The
// extension host registers this path with the renderer at
// activation (see activate() in src/extension.ts).
// media/resvg is generated, not committed - like media/monaco.
import { cp, access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, '..', 'ts-core', 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm');
const targetDir = join(root, 'media', 'resvg');
try {
  await access(source);
} catch {
  console.error('@resvg/resvg-wasm not found under ../ts-core/node_modules; run npm install in packages/ts-core first');
  process.exit(1);
}
await mkdir(targetDir, { recursive: true });
await cp(source, join(targetDir, 'index_bg.wasm'));
console.log(`Copied the resvg WASM binary to ${targetDir}`);
