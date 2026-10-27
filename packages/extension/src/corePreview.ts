// Production preview renderer: the edited source is validated and
// rendered only by the Python Core, through the bridge package (P1-04).
// Validation runs on the bridge's LatestValidation lane, so a superseded
// source cancels its predecessor; rendering then uses the Core `build`
// command into a private preview file whose raster is the Core's own
// rendering of the edited source. Nothing is rendered before validation
// succeeds, and the built file is never the user's document.
import { mkdir } from 'node:fs/promises';
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
  return async (source: string, revision: number): Promise<string> => {
    const python = options.pythonPath?.trim();
    if (!python)
      throw new PreviewUnavailableError('Edited preview needs the Python Core: set "vectorPng.corePythonPath" to a Python 3.11-3.13 with vector-png-editor installed. The managed environment integration is tracked separately.');
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
    const output = join(options.previewDir, `preview-${options.documentKey}-${++sequence}.png`);
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
