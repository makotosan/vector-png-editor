import type { Detection } from './detect.ts';

// Pure decision for how the custom editor opens a detected file. Kept
// free of the VS Code API so it can be unit-tested in plain Node.
//
// - vector-png: the full editor (Monaco source + preview + save).
// - ordinary-png: a view-only mode (Issue #46). The file has no embedded
//   SVG source, so there is nothing to edit - but viewing a plain image
//   must never be an error, so the custom editor shows the raster instead
//   of rejecting the document.
// - corrupt-vector-png / not-png: rejected, preserving the existing
//   diagnostics exactly. Only the ordinary-PNG case changed.
export type OpenMode =
  | { mode: 'edit'; width: number; height: number }
  | { mode: 'view'; width: number; height: number }
  | { mode: 'reject'; diagnostic: string };

export function openModeFor(detection: Detection): OpenMode {
  switch (detection.kind) {
    case 'vector-png':
      return { mode: 'edit', width: detection.width, height: detection.height };
    case 'ordinary-png':
      return { mode: 'view', width: detection.width, height: detection.height };
    case 'corrupt-vector-png':
    case 'not-png':
      return { mode: 'reject', diagnostic: detection.diagnostic };
  }
}
