// Typed errors for the TypeScript Core, mirroring the Python Core's
// CoreError shape (a stable machine-readable `code` plus a message).
// Callers branch on `code`, never on message text. Codes used in this
// slice deliberately match the Python Core's where the condition is
// the same condition ('resource-limit'), so a future integration can
// map both engines' failures onto one surface.
export class TsCoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TsCoreError';
    this.code = code;
  }
}
