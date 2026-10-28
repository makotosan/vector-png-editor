// Production save dependencies: hashing/existence from the local file
// system, building through the bridge package's Core runner (P1-04).
// The Core performs full validation before publication and publishes
// atomically with a backup snapshot; see docs/WRITING.md.
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { runCore, BridgeError } from '../../bridge/src/core.ts';
import { SaveUnavailableError, type BuildOutcome, type SaveDeps } from './save.ts';

let sequence = 0;

export function createCoreSaveDeps(pythonPath: string | undefined): SaveDeps {
  return {
    async sha256File(path: string): Promise<string> {
      const bytes = await readFile(path);
      return createHash('sha256').update(bytes).digest('hex');
    },
    async targetExists(path: string): Promise<boolean> {
      try { await access(path); return true; } catch { return false; }
    },
    async build(request): Promise<BuildOutcome> {
      const python = pythonPath?.trim();
      if (!python)
        throw new SaveUnavailableError('Saving needs the Python Core: run the command “Vector PNG: Set Up Python Environment” or set "vectorPng.corePythonPath" to a Python 3.11-3.13 with the Core installed. Your edits are preserved in the dirty buffer.');
      let response;
      try {
        response = await runCore(python, {
          protocol: 1, command: 'build', request_id: `save-${Date.now()}-${++sequence}`,
          source_base64: request.sourceBase64, output: request.output,
          width: request.width, height: request.height,
          overwrite: request.overwrite, expected_sha256: request.expectedSha256,
        });
      } catch (error) {
        if (error instanceof BridgeError) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
      if (!response.response.ok)
        return { ok: false, code: response.response.error?.code ?? 'unknown', message: response.response.error?.message ?? 'The Core rejected the save' };
      const backup = response.response.result?.backup;
      return { ok: true, backup: typeof backup === 'string' ? backup : null };
    },
  };
}
