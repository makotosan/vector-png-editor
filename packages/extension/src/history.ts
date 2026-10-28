// Authoritative per-document source history (P2-05). VS Code's custom
// document undo stack and the Monaco model both delegate to this single
// record, so the two can never diverge:
//
// - A webview edit is recorded once, here. Identical re-deliveries
//   (host sync echoes) record nothing, which breaks the feedback loop.
// - The edit event's undo/redo closures only move this history's
//   pointer and sync the resulting snapshot to the webviews; they
//   never record new entries.
// - Saving does not touch the history, so undo across a save works and
//   dirtiness is always `current() !== savedSource`.
// - Revert and backup-restore reset the history to the restored
//   snapshot, which becomes both the current and the saved state.
//
// Snapshots are full sources (bounded by the 1 MB source limit). The
// history is capped by entry count and total bytes; the oldest entries
// are dropped first, never the current one.
export type RecordOptions = {
  now: number;
  // Consecutive edits sharing a coalesce key within the window merge
  // into one undoable entry (typing bursts arrive as many changes).
  coalesceKey?: string;
};

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 16_000_000;
const DEFAULT_COALESCE_MS = 1_000;

type Entry = { source: string; coalesceKey?: string; at: number };

export class SourceHistory {
  private entries: Entry[];
  private pointer = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly coalesceMs: number;

  constructor(initial: string, limits: { maxEntries?: number; maxBytes?: number; coalesceMs?: number } = {}) {
    this.entries = [{ source: initial, at: 0 }];
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.coalesceMs = limits.coalesceMs ?? DEFAULT_COALESCE_MS;
  }

  current(): string {
    return this.entries[this.pointer].source;
  }

  get canUndo(): boolean { return this.pointer > 0; }
  get canRedo(): boolean { return this.pointer < this.entries.length - 1; }
  get size(): number { return this.entries.length; }

  isDirty(savedSource: string): boolean {
    return this.current() !== savedSource;
  }

  // Records a webview edit. Returns false when the value equals the
  // current snapshot (an echo of a host sync, or a no-op change), so
  // the caller must not fire an edit event for it.
  recordEdit(next: string, options: RecordOptions): boolean {
    if (next === this.current()) return false;
    // A new edit discards the redo tail.
    this.entries.length = this.pointer + 1;
    const tip = this.entries[this.pointer];
    if (options.coalesceKey !== undefined && tip.coalesceKey === options.coalesceKey
        && options.now - tip.at <= this.coalesceMs && this.entries.length > 1) {
      tip.source = next;
      tip.at = options.now;
      return true;
    }
    this.entries.push({ source: next, coalesceKey: options.coalesceKey, at: options.now });
    this.pointer += 1;
    this.trim();
    return true;
  }

  undo(): string | undefined {
    if (!this.canUndo) return undefined;
    this.pointer -= 1;
    return this.current();
  }

  redo(): string | undefined {
    if (!this.canRedo) return undefined;
    this.pointer += 1;
    return this.current();
  }

  // Revert / restore: the given snapshot becomes the only state.
  reset(source: string): void {
    this.entries = [{ source, at: 0 }];
    this.pointer = 0;
  }

  private trim(): void {
    let total = this.entries.reduce((sum, e) => sum + e.source.length, 0);
    while (this.pointer > 0 && (this.entries.length > this.maxEntries || total > this.maxBytes)) {
      total -= this.entries[0].source.length;
      this.entries.shift();
      this.pointer -= 1;
    }
  }
}
