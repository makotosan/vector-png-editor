// External-change tracking for one document (P2-06), framework-free.
//
// The tracker knows the SHA-256 of the file bytes the editor last
// agreed with (at open, after a save, after a reload). Every observed
// disk state is classified:
//
// - same hash            -> 'ignore' (covers the echo of our own save,
//                           which is recognized by content, not timing)
// - different, clean doc -> 'reload' (adopt the disk version)
// - different, dirty doc -> 'conflict' (the buffer is preserved; a
//                           later save must resolve explicitly, so an
//                           external edit can never be silently lost)
// - unreadable/corrupt   -> 'conflict' (never reload unchecked content)
// - missing              -> 'deleted' when clean, 'conflict' when dirty
//
// The save path's revision token (P2-04) is the second line of defense:
// even if a change slips between observation and save, the Core
// refuses to overwrite a destination whose token no longer matches.
export type ChangeDecision = 'ignore' | 'reload' | 'conflict' | 'deleted';

export class ExternalChangeTracker {
  private knownSha: string;
  private conflicted = false;
  private deleted = false;

  constructor(knownSha: string) {
    this.knownSha = knownSha;
  }

  get isConflicted(): boolean { return this.conflicted; }
  get isDeleted(): boolean { return this.deleted; }
  get agreedSha(): string { return this.knownSha; }

  // Our own save published `sha`: agree with it and clear any conflict.
  noteSaved(sha: string): void {
    this.knownSha = sha;
    this.conflicted = false;
    this.deleted = false;
  }

  // A reload adopted the disk version at `sha`.
  noteReloaded(sha: string): void {
    this.noteSaved(sha);
  }

  // The user explicitly chose to overwrite the external version; the
  // save that follows re-reads the destination token, so only the
  // conflict flag needs clearing here.
  resolveOverwrite(): void {
    this.conflicted = false;
  }

  // The disk file could not be parsed as a valid document: never
  // reload it, whatever the buffer state.
  observeUnreadable(): ChangeDecision {
    this.conflicted = true;
    return 'conflict';
  }

  observe(sha: string | null, isDirty: boolean): ChangeDecision {
    if (sha === null) {
      if (this.deleted) return 'ignore';
      this.deleted = true;
      if (isDirty) {
        this.conflicted = true;
        return 'conflict';
      }
      return 'deleted';
    }
    this.deleted = false;
    if (sha === this.knownSha) {
      this.conflicted = false;
      return 'ignore';
    }
    if (!isDirty) {
      this.knownSha = sha;
      this.conflicted = false;
      return 'reload';
    }
    this.conflicted = true;
    return 'conflict';
  }
}
