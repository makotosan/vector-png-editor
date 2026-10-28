import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Plain-text save for `.svg` documents (Issue #47), framework-free so
// the flow can be unit-tested against the real file system.
//
// An SVG file is its own source: saving writes the current source text
// back as UTF-8 bytes, byte-exact (BOM and newline style ride along in
// the text), with no Core rebuild. The one hazard a PNG save delegates
// to the Core - the file changing between the editor's last agreement
// and the write - is guarded here by the same revision-token idea: the
// caller passes the SHA-256 the editor last agreed with, and a
// mismatch refuses the write instead of silently clobbering.
export class SvgSaveConflictError extends Error {}
export class SvgSaveFailedError extends Error {}

export type SvgSaveDeps = {
  sha256File: (path: string) => Promise<string>;
  writeFileBytes: (path: string, bytes: Uint8Array) => Promise<void>;
};

export function createNodeSvgSaveDeps(): SvgSaveDeps {
  return {
    async sha256File(path: string): Promise<string> {
      const bytes = await readFile(path);
      return createHash('sha256').update(bytes).digest('hex');
    },
    async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
      await writeFile(path, bytes);
    },
  };
}

// Writes `text` to `path` as UTF-8. When `expectedSha256` is given, the
// file must still hash to it; a missing file or a different hash is a
// conflict and nothing is written. Returns the SHA-256 of the written
// bytes so the caller can advance its revision agreement.
export async function saveSvgTextFile(
  deps: SvgSaveDeps,
  path: string,
  text: string,
  expectedSha256?: string,
): Promise<{ sha256: string }> {
  const bytes = new TextEncoder().encode(text);
  if (expectedSha256 !== undefined) {
    let current: string;
    try {
      current = await deps.sha256File(path);
    } catch {
      throw new SvgSaveConflictError('The file no longer exists on disk; refusing to recreate it silently');
    }
    if (current !== expectedSha256)
      throw new SvgSaveConflictError('The file changed on disk since the editor last agreed with it; refusing to overwrite silently');
  }
  await deps.writeFileBytes(path, bytes);
  return { sha256: createHash('sha256').update(bytes).digest('hex') };
}
