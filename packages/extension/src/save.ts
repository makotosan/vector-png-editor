// Source-preserving save orchestration (P2-04), framework-free so the
// flow can be unit-tested with fake Core dependencies.
//
// Saving never writes bytes directly: the edited source goes through
// the Core `build` path, which validates the profile, renders, verifies
// the candidate and only then publishes atomically. Any failure leaves
// the original file and the dirty buffer untouched - the caller keeps
// the document dirty by throwing.
export class SaveBlockedError extends Error {}     // profile/invalid source: save is forbidden
export class SaveConflictError extends Error {}    // destination changed since the revision token
export class SaveUnavailableError extends Error {} // no Core configured
export class SaveCancelledError extends Error {}
export class SaveFailedError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export type BuildRequest = {
  sourceBase64: string;
  output: string;
  width: number;
  height: number;
  overwrite: boolean;
  expectedSha256?: string;
};
export type BuildOutcome =
  | { ok: true; backup: string | null }
  | { ok: false; code: string; message: string };

export type SaveDeps = {
  // SHA-256 of the file's current bytes; this is the Core revision token.
  sha256File: (path: string) => Promise<string>;
  targetExists: (path: string) => Promise<boolean>;
  build: (request: BuildRequest) => Promise<BuildOutcome>;
};

export type SaveInput = {
  source: string;
  width: number;
  height: number;
  isCancelled?: () => boolean;
};

function throwFor(outcome: Extract<BuildOutcome, { ok: false }>): never {
  if (outcome.code === 'invalid-svg' || outcome.code === 'unsupported-profile' || outcome.code === 'invalid-container')
    throw new SaveBlockedError(outcome.message);
  if (outcome.code === 'conflict') throw new SaveConflictError(outcome.message);
  if (outcome.code === 'cancelled') throw new SaveCancelledError(outcome.message);
  throw new SaveFailedError(outcome.code, outcome.message);
}

async function runBuild(deps: SaveDeps, input: SaveInput, output: string, overwrite: boolean, expectedSha256?: string): Promise<{ backup: string | null }> {
  if (input.isCancelled?.()) throw new SaveCancelledError('Save cancelled before the Core was started');
  const outcome = await deps.build({
    sourceBase64: Buffer.from(input.source, 'utf8').toString('base64'),
    output, width: input.width, height: input.height, overwrite, expectedSha256,
  });
  if (!outcome.ok) throwFor(outcome);
  return { backup: outcome.backup };
}

// Save over the document's own file. The revision token is read from the
// file's current bytes immediately before the build, so an external
// change is detected by the Core and reported as a conflict instead of
// being silently overwritten.
export async function saveInPlace(deps: SaveDeps, path: string, input: SaveInput): Promise<{ backup: string | null }> {
  const token = await deps.sha256File(path);
  return runBuild(deps, input, path, true, token);
}

// Save As: a new destination is created without overwrite; an existing
// destination is overwritten only under its own current revision token
// (the editor's Save As dialog has already confirmed the replacement).
export async function saveAs(deps: SaveDeps, targetPath: string, input: SaveInput): Promise<{ backup: string | null }> {
  if (await deps.targetExists(targetPath)) {
    const token = await deps.sha256File(targetPath);
    return runBuild(deps, input, targetPath, true, token);
  }
  return runBuild(deps, input, targetPath, false);
}
