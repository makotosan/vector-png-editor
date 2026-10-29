// The TypeScript Core as the extension's in-process build engine
// (Issue #58): the production replacement for the bridge `build`
// path shared by save (coreSave.ts), export (coreExport.ts) and
// previews (corePreview.ts).
//
// buildVectorPngBytes mirrors the Python Core's writing._candidate:
// validate the source (svg.validate_source), render it at the
// viewport, keep only the raster chunks of the render and insert
// the source iTXt after IHDR, then self-verify the candidate
// exactly as the Core's verify_bytes does - re-read the container,
// require the embedded source to round-trip byte-exactly, re-render
// and require the same picture. The Core compares decoded pixels
// across two CairoSVG renders; here both renders come from the
// same in-process engine with the same font buffers, so the
// assembled candidates are compared byte-for-byte, which is the
// same check in engine-local terms (cross-engine byte identity was
// never a property of the format - see ts-core's container.ts).
//
// publishBytes mirrors writing._publish: the revision-token
// discipline, the per-output lock file, the symlink refusal, the
// backup snapshot on overwrite, and create-without-clobber via a
// hard link. Error codes and messages are the Core's own.
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  MAX_PNG, assembleVectorPng, parseDocument,
} from '../../ts-core/src/container.ts';
import { TsCoreError } from '../../ts-core/src/errors.ts';
import { validateSource } from '../../ts-core/src/validate.ts';
import { renderSvgToPng, setWasmSource } from '../../ts-core/src/render.ts';
import type { HostFonts } from './hostFonts.ts';
import type { BuildOutcome } from './save.ts';

export interface TsCoreRuntime {
  /** The activation's shared host fonts (loaded at most once). */
  fonts: Promise<HostFonts>;
}

/**
 * Create the runtime shared by every TS Core consumer in this
 * activation. When the host knows where the resvg wasm lives (the
 * packaged media path, or the ts-core package in a checkout), it is
 * registered before any render can happen.
 */
export function createTsCoreRuntime(options: {
  fonts: Promise<HostFonts>;
  wasmPath?: string;
}): TsCoreRuntime {
  if (options.wasmPath !== undefined) setWasmSource(options.wasmPath);
  return { fonts: options.fonts };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// The renderer consumes text; the container carries bytes. The
// source is validated as bytes first (which enforces UTF-8), and a
// leading BOM - preserved in the embedded bytes - is not part of
// the text the XML parser should see, matching the Core, whose
// decoder hands CairoSVG a string whose BOM the XML parser skips.
export function sourceTextForRender(sourceBytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(sourceBytes);
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/**
 * Validate, render, assemble and self-verify a vector-png for the
 * given source bytes. Throws TsCoreError with the Core's codes
 * ('unsupported-profile', 'invalid-svg', 'resource-limit',
 * 'render-failed', 'render-mismatch', 'external-reference').
 */
export async function buildVectorPngBytes(
  runtime: TsCoreRuntime,
  sourceBytes: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  validateSource(sourceBytes);
  const { fonts, defaultFamily } = await runtime.fonts;
  const renderOptions = {
    width, height, fonts,
    defaultFontFamily: defaultFamily, sansSerifFamily: defaultFamily,
  };
  const text = sourceTextForRender(sourceBytes);
  const rendered = await renderSvgToPng(text, renderOptions);
  const candidate = assembleVectorPng(rendered.png, sourceBytes);
  // Self-verification, mirroring writing._candidate's verify_bytes.
  const doc = parseDocument(candidate);
  if (doc.source === null || !bytesEqual(doc.source, sourceBytes)) {
    throw new TsCoreError('render-mismatch', 'Generated PNG failed source/preview verification');
  }
  if (doc.width !== width || doc.height !== height) {
    throw new TsCoreError('render-failed', 'Renderer returned a different viewport');
  }
  const fresh = await renderSvgToPng(text, renderOptions);
  const freshCandidate = assembleVectorPng(fresh.png, sourceBytes);
  if (!bytesEqual(freshCandidate, candidate)) {
    throw new TsCoreError('render-mismatch', 'Generated PNG failed source/preview verification');
  }
  return candidate;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

async function fsyncFile(path: string, data: Uint8Array, flag: string): Promise<void> {
  const handle = await open(path, flag, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publish candidate bytes with the Core's discipline
 * (writing._publish). Resolves the backup path (or null) on
 * success; throws TsCoreError ('invalid-arguments', 'conflict',
 * 'output-exists', 'resource-limit') or a filesystem error.
 */
export async function publishBytes(
  data: Uint8Array,
  output: string,
  options: { overwrite: boolean; expectedSha256?: string },
): Promise<{ backup: string | null }> {
  const { overwrite, expectedSha256 } = options;
  if (overwrite !== (expectedSha256 !== undefined)) {
    throw new TsCoreError('invalid-arguments', 'Overwrite requires an expected PNG SHA-256 token');
  }
  if (expectedSha256 !== undefined && !TOKEN_PATTERN.test(expectedSha256)) {
    throw new TsCoreError('invalid-arguments', 'Expected SHA-256 must be 64 lowercase hexadecimal characters');
  }
  const dir = dirname(output);
  const name = basename(output);
  const lockPath = join(dir, `${name}.vector-png.lock`);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TsCoreError('conflict', 'Another save owns the output lock');
    }
    throw error;
  }
  let tempPath: string | undefined;
  let backup: string | null = null;
  try {
    await lockHandle.close();
    lockHandle = undefined;
    let targetStat;
    try {
      targetStat = await lstat(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (targetStat?.isSymbolicLink()) {
      throw new TsCoreError('conflict', 'Saving through a symlink is forbidden');
    }
    let original: Buffer | undefined;
    if (overwrite) {
      original = await readFile(output);
      if (original.length > MAX_PNG) {
        throw new TsCoreError('resource-limit', `Input exceeds ${MAX_PNG} bytes`);
      }
      if (createHash('sha256').update(original).digest('hex') !== expectedSha256) {
        throw new TsCoreError('conflict', 'Output changed since the supplied revision');
      }
    } else if (targetStat !== undefined) {
      throw new TsCoreError('output-exists', 'Output already exists');
    }
    tempPath = join(dir, `.vector-png-save-${randomUUID().replaceAll('-', '')}`);
    await fsyncFile(tempPath, data, 'w');
    if (overwrite) {
      backup = join(dir, `${name}.${randomUUID().replaceAll('-', '')}.backup`);
      await fsyncFile(backup, original!, 'wx');
      const nowStat = await lstat(output).catch(() => undefined);
      if (nowStat?.isSymbolicLink() || original === undefined
        || !bytesEqual(await readFile(output), original)) {
        // The Core retains the backup in this case on purpose: it
        // is the only copy of the pre-save bytes.
        throw new TsCoreError('conflict', 'Output changed during save; backup retained');
      }
      await rename(tempPath, output);
      tempPath = undefined;
    } else {
      try {
        await link(tempPath, output);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new TsCoreError('output-exists', 'Output appeared during save');
        }
        throw error;
      }
    }
    return { backup };
  } finally {
    if (lockHandle !== undefined) await lockHandle.close().catch(() => undefined);
    if (tempPath !== undefined) await unlink(tempPath).catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export interface BuildToFileRequest {
  sourceBase64: string;
  output: string;
  width: number;
  height: number;
  overwrite: boolean;
  expectedSha256?: string;
}

/**
 * The bridge `build` contract, in-process: never throws for a Core
 * refusal - failures resolve as a BuildOutcome with the Core's code
 * (filesystem failures as 'io-error', as the Core's CLI maps them).
 */
export async function buildToFile(
  runtime: TsCoreRuntime,
  request: BuildToFileRequest,
): Promise<BuildOutcome> {
  try {
    const sourceBytes = Buffer.from(request.sourceBase64, 'base64');
    const data = await buildVectorPngBytes(runtime, sourceBytes, request.width, request.height);
    const { backup } = await publishBytes(data, request.output, {
      overwrite: request.overwrite,
      expectedSha256: request.expectedSha256,
    });
    return { ok: true, backup };
  } catch (error) {
    if (error instanceof TsCoreError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'io-error', message: error instanceof Error ? error.message : String(error) };
  }
}
