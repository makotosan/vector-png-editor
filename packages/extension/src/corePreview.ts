// Production preview renderer (Issue #58): the edited source is
// validated and rendered in-process by the TypeScript Core
// (packages/ts-core) and resolved as a data URI, which the host
// posts straight to the webview. Nothing is rendered before
// validation succeeds.
//
// This replaces the Python bridge path (validate on the bridge's
// LatestValidation lane, then `build` into a private preview
// file). The temp-file machinery that path needed - exclusive
// publish names, the per-instance token, the hourly sweep of the
// persistent previews directory - existed only because the Core
// published files, and is gone with it. Supersession is a local
// generation counter: validation is synchronous, and a render that
// finishes after a newer source arrived is reported stale, exactly
// as the cancelled bridge lane reported it; the PreviewController
// generation check remains the second line of defense.
import { TsCoreError } from '../../ts-core/src/errors.ts';
import { validateSource } from '../../ts-core/src/validate.ts';
import { renderSvgToPng } from '../../ts-core/src/render.ts';
import {
  PreviewInvalidError, PreviewStaleError, PreviewUnavailableError, type PreviewRenderer,
} from './preview.ts';
import { sourceTextForRender, type TsCoreRuntime } from './tsCore.ts';

export interface TsPreviewOptions {
  runtime: TsCoreRuntime;
  width: number;
  height: number;
}

export function createCorePreviewRenderer(options: TsPreviewOptions): PreviewRenderer {
  let latest = 0;
  return async (source: string, _revision: number): Promise<string> => {
    const generation = ++latest;
    try {
      validateSource(Buffer.from(source, 'utf8'));
    } catch (error) {
      if (error instanceof TsCoreError) throw new PreviewInvalidError(error.message);
      throw new PreviewUnavailableError(error instanceof Error ? error.message : String(error));
    }
    let fonts;
    try {
      fonts = await options.runtime.fonts;
    } catch (error) {
      throw new PreviewUnavailableError(
        `Host fonts could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (generation !== latest) throw new PreviewStaleError('superseded');
    let rendered;
    try {
      rendered = await renderSvgToPng(sourceTextForRender(Buffer.from(source, 'utf8')), {
        width: options.width,
        height: options.height,
        fonts: fonts.fonts,
        defaultFontFamily: fonts.defaultFamily,
        sansSerifFamily: fonts.defaultFamily,
      });
    } catch (error) {
      // The source validated; a render refusal (viewport caps,
      // external-reference scan, engine failure) is a property of
      // the source at this viewport, reported like the Core build
      // refusal was. Anything else is an environment failure.
      if (error instanceof TsCoreError) throw new PreviewInvalidError(error.message);
      throw new PreviewUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (generation !== latest) throw new PreviewStaleError('superseded');
    return `data:image/png;base64,${Buffer.from(rendered.png).toString('base64')}`;
  };
}
