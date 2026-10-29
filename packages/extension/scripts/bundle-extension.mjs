// Bundles the extension host code (src/extension.ts and everything it
// imports, including the bridge sources under ../../bridge/src and
// the TypeScript Core sources under ../../ts-core/src) into
// out/extension.js with esbuild. Required for VSIX packaging: the
// declared entry point is out/extension.js, and the bridge/ts-core
// live outside the extension folder, so a plain tsc emit cannot
// produce a self-contained VSIX (Issue #20 dry-run finding).
//
// The @resvg/resvg-wasm JS glue is bundled like everything else;
// its WASM binary is not code and cannot be bundled - it is copied
// to media/resvg by scripts/copy-resvg.mjs and the host registers
// that path with the renderer at activation, so the ts-core
// renderer's package-relative fallback resolution never runs in
// the packaged layout.
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
