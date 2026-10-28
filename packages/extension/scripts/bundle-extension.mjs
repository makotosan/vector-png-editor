// Bundles the extension host code (src/extension.ts and everything it
// imports, including the bridge sources under ../../bridge/src) into
// out/extension.js with esbuild. Required for VSIX packaging: the
// declared entry point is out/extension.js, and the bridge lives
// outside the extension folder, so a plain tsc emit cannot produce a
// self-contained VSIX (Issue #20 dry-run finding).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  entryPoints: [join(root, 'src', 'extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: join(root, 'out', 'extension.js'),
});
console.log('Bundled extension host to out/extension.js');
