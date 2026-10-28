// Production preview renderer: the edited source is validated and
// rendered only by the Python Core, through the bridge package (P1-04).
// Validation runs on the bridge's LatestValidation lane, so a superseded
// source cancels its predecessor; rendering then uses the Core `build`
// command into a private preview file whose raster is the Core's own
// rendering of the edited source. Nothing is rendered before validation
// succeeds, and the built file is never the user's document.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LatestValidation, runCore, BridgeError } from '../../bridge/src/core.ts';
import { PreviewInvalidError, PreviewStaleError, PreviewUnavailableError, type PreviewRenderer } from './preview.ts';

export type CorePreviewOptions = {
  pythonPath: string | undefined;
  previewDir: string;
  width: number;
  height: number;
  documentKey: string;
};

export function createCorePreviewRenderer(options: CorePreviewOptions): PreviewRenderer {
  const lane = new LatestValidation();
  let sequence = 0;
  // The Core publishes its build output exclusively (an existing
  // output is refused), and the previews directory persists across
  // sessions, so the output name must be unique per renderer
  // instance: a bare sequence restarts at 1 for every reopened
  // editor and collides with the previous session's leftover file,
  // which made every edited preview fail with "Output already
  // exists" (user report, 2026-10-29).
  const instance = randomUUID().replaceAll('-', '').slice(0, 12);
  let swept = false;
  const sweepStalePreviews = async (): Promise<void> => {
    // Best effort, once per instance: drop this document's preview
    // files left by earlier instances once they are an hour old, so
    // the persistent directory does not grow without bound. Fresh
    // files are kept - another live panel may be about to read the
    // render it just produced (the host reads it into a data URI;
    // after that read the file is never needed again).
    try {
      const prefix = `preview-${options.documentKey}-`;
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const name of await readdir(options.previewDir)) {
        if (!name.startsWith(prefix) || !name.endsWith('.png')) continue;
        const path = join(options.previewDir, name);
        try {
          if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
        } catch { /* a vanished or busy file is fine */ }
      }
    } catch { /* the directory may not exist yet */ }
  };
  return async (source: string, revision: number): Promise<string> => {
    const python = options.pythonPath?.trim();
    if (!python)
      throw new PreviewUnavailableError('Edited preview needs the Python Core: run the command “Vector PNG: Set Up Python Environment” or set "vectorPng.corePythonPath" to a Python 3.11-3.13 with the Core installed.');
    const sourceBase64 = Buffer.from(source, 'utf8').toString('base64');
    const requestId = `preview-${options.documentKey}-${revision}`;
    let validation;
    try {
      validation = await lane.run(python, {
        protocol: 1, command: 'validate', request_id: requestId,
        source_base64: sourceBase64, width: options.width, height: options.height,
      });
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'cancelled') throw new PreviewStaleError('superseded');
      throw new PreviewUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (validation === undefined) throw new PreviewStaleError('superseded');
    if (!validation.response.ok)
      throw new PreviewInvalidError(validation.response.error?.message ?? 'The Core rejected the source');
    await mkdir(options.previewDir, { recursive: true });
    if (!swept) {
      swept = true;
      await sweepStalePreviews();
    }
    const output = join(options.previewDir, `preview-${options.documentKey}-${instance}-${++sequence}.png`);
    let built;
    try {
      built = await runCore(python, {
        protocol: 1, command: 'build', request_id: `${requestId}-build`,
        source_base64: sourceBase64, output, width: options.width, height: options.height, overwrite: false,
      });
    } catch (error) {
      throw new PreviewUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (!built.response.ok)
      throw new PreviewInvalidError(built.response.error?.message ?? 'The Core could not render the source');
    return output;
  };
}
