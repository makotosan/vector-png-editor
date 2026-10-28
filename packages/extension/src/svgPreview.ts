import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PreviewInvalidError, type PreviewRenderer } from './preview.ts';
import { hasSvgRoot } from './svgSource.ts';

// Edited-preview renderer for plain `.svg` documents (Issue #47).
//
// Display is never blocked by safe-svg-v1: the Core's preview path
// validates against the profile before rendering, so it cannot show a
// general SVG at all. Instead the current source is written to a
// private file in the preview directory (the same discipline the Core
// preview uses for its PNGs) and the webview shows that file through
// its <img> element. The SVG never becomes DOM markup: an <img> loads
// it in the browser's script-disabled image context, under the same
// restrictive CSP as the PNG preview. A source without an <svg> root
// is reported as an invalid preview; the document still opens and the
// saved view (the file itself, also via <img>) is unaffected.
export type SvgPreviewOptions = {
  previewDir: string;
  documentKey: string;
};

export function createSvgPreviewRenderer(options: SvgPreviewOptions): PreviewRenderer {
  let sequence = 0;
  return async (source: string): Promise<string> => {
    if (!hasSvgRoot(source))
      throw new PreviewInvalidError('The source has no <svg> root element to preview');
    await mkdir(options.previewDir, { recursive: true });
    const output = join(options.previewDir, `preview-${options.documentKey}-${++sequence}.svg`);
    await writeFile(output, source, 'utf8');
    return output;
  };
}
