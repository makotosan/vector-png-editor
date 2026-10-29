// Production save dependencies (Issue #58): hashing/existence from
// the local file system, building in-process through the TypeScript
// Core (src/tsCore.ts). The build performs full validation before
// publication and publishes atomically with a backup snapshot,
// mirroring the Python Core's writing.py - see docs/WRITING.md.
// No Python environment is involved in saving any more.
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import type { BuildOutcome, SaveDeps } from './save.ts';
import { buildToFile, type TsCoreRuntime } from './tsCore.ts';

export function createCoreSaveDeps(runtime: TsCoreRuntime): SaveDeps {
  return {
    async sha256File(path: string): Promise<string> {
      const bytes = await readFile(path);
      return createHash('sha256').update(bytes).digest('hex');
    },
    async targetExists(path: string): Promise<boolean> {
      try { await access(path); return true; } catch { return false; }
    },
    async build(request): Promise<BuildOutcome> {
      return buildToFile(runtime, request);
    },
  };
}
