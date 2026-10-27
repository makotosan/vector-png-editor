import type { Detection } from './detect.ts';

// Pure routing decision used by the "Vector PNG: Open in Editor" command.
// Kept free of the VS Code API so it can be unit-tested in plain Node.
export type Route =
  | { action: 'open-custom-editor' }
  | { action: 'open-default-viewer' }
  | { action: 'show-diagnostic'; message: string };

export function routeFor(detection: Detection, fileName: string): Route {
  switch (detection.kind) {
    case 'vector-png':
      return { action: 'open-custom-editor' };
    case 'ordinary-png':
      // Never hijack ordinary PNGs: the standard image viewer stays default.
      return { action: 'open-default-viewer' };
    case 'corrupt-vector-png':
      return { action: 'show-diagnostic', message: `${fileName} looks like a vector-png file but is malformed: ${detection.diagnostic}` };
    case 'not-png':
      return { action: 'show-diagnostic', message: `${fileName} is not a PNG file: ${detection.diagnostic}` };
  }
}
