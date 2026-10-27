// Debounced edited-preview pipeline (P2-03). Framework-free so it can be
// unit-tested with fake timers and a fake renderer.
//
// Rules from the issue: render only after 300 ms idle; the latest source
// wins and stale results are discarded; an invalid source is never
// rendered unchecked (the renderer validates first and rejects); the
// controller never switches the visible preview mode - toggling between
// the edited preview and the saved raster is a manual webview action.
export const PREVIEW_DEBOUNCE_MS = 300;

export class PreviewInvalidError extends Error {}
export class PreviewUnavailableError extends Error {}
export class PreviewStaleError extends Error {}

export type PreviewEvent =
  | { type: 'rendered'; revision: number; imagePath: string }
  | { type: 'invalid'; revision: number; message: string }
  | { type: 'unavailable'; revision: number; message: string };

// Renders one source revision to a PNG file and returns its path. Must
// reject with PreviewInvalidError when the source fails validation and
// with PreviewUnavailableError when no renderer is configured.
export type PreviewRenderer = (source: string, revision: number) => Promise<string>;

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PreviewController {
  private timer: unknown;
  private generation = 0;
  private disposed = false;
  private readonly renderer: PreviewRenderer;
  private readonly emit: (event: PreviewEvent) => void;
  private readonly timers: Timers;
  private readonly debounceMs: number;

  constructor(
    renderer: PreviewRenderer,
    emit: (event: PreviewEvent) => void,
    timers: Timers = systemTimers,
    debounceMs: number = PREVIEW_DEBOUNCE_MS,
  ) {
    this.renderer = renderer;
    this.emit = emit;
    this.timers = timers;
    this.debounceMs = debounceMs;
  }

  schedule(source: string, revision: number): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.run(generation, source, revision);
    }, this.debounceMs);
  }

  private async run(generation: number, source: string, revision: number): Promise<void> {
    let imagePath: string;
    try {
      imagePath = await this.renderer(source, revision);
    } catch (error) {
      if (this.disposed || generation !== this.generation || error instanceof PreviewStaleError) return;
      if (error instanceof PreviewInvalidError)
        this.emit({ type: 'invalid', revision, message: error.message });
      else if (error instanceof PreviewUnavailableError)
        this.emit({ type: 'unavailable', revision, message: error.message });
      else
        this.emit({ type: 'unavailable', revision, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    // A newer edit was scheduled while this render ran: discard the result.
    if (this.disposed || generation !== this.generation) return;
    this.emit({ type: 'rendered', revision, imagePath });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
