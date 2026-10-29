import { walkChunks } from './png.ts';
import { SOURCE_KEYWORD } from './detect.ts';
import { ExportCoreError, type ProfileValidation } from './export.ts';

// Export the rendered raster as a PLAIN PNG (Issue #45): a vector-png
// without its embedded source chunk, for consumers that just want the
// picture. Framework-free so the flow can be unit-tested with fakes.
//
// The route follows the source, exactly like the vector-png export:
// a source that passes the safe-svg-v1 profile gate renders through
// the build route; a source that fails the gate renders through the
// normalization `convert` route, and the result says so, so the user
// knows the picture came from the normalized form. Since Issue #58
// the gate and the build route run in-process on the TypeScript
// Core; `convert` still runs the Python Core (its port is Phase 2,
// Issue #59). If the chosen route fails, the other route is tried
// once; only when both fail is an error reported (the primary
// route's - the one the validation dictated). Whichever route
// produced it, the built vector-png is stripped of exactly its one
// source chunk here, and only the stripped bytes are ever written.
// A failure at any step writes nothing, and the open document is
// never touched.

export type PlainPngRenderOutcome =
  | { ok: true; png: Uint8Array; warnings: string[] }
  | { ok: false; code: string; message: string };

export type ExportPngDeps = {
  // Core `validate --profile safe-svg-v1` over the given source text.
  // Rejects with ExportCoreError when the Core cannot run at all.
  validateProfile: (source: string, width: number, height: number) => Promise<ProfileValidation>;
  // Core `build` into a private temp vector-png; resolves its bytes.
  renderViaBuild: (source: string, width: number, height: number) => Promise<PlainPngRenderOutcome>;
  // Core `convert` (normalization route) into a private temp
  // vector-png; resolves its bytes and the conversion warnings.
  renderViaConvert: (source: string) => Promise<PlainPngRenderOutcome>;
  // UI: the save dialog. Resolves the chosen path or null on cancel.
  chooseTarget: (defaultPath: string) => Promise<string | null>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
};

export type ExportPngInput = {
  source: string;
  width: number;
  height: number;
  defaultPath: string;
};

export type ExportPngResult =
  | { status: 'exported'; targetPath: string; viaNormalization: boolean; warnings: string[] }
  | { status: 'cancelled' }
  | { status: 'failed'; stage: 'validate' | 'render' | 'strip' | 'write'; code: string; message: string };

// Removes exactly the one embedded source chunk (the compressed iTXt
// with the vector-png keyword) from a built vector-png. Every other
// chunk is copied as its raw bytes, so the raster and all metadata
// survive byte-identically; only the chunk's own bytes are dropped.
export function stripSourceChunk(bytes: Uint8Array): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  const walk = walkChunks(bytes);
  if (!walk.ok) return { ok: false, reason: walk.reason };
  const isSource = (chunk: (typeof walk.chunks)[number]): boolean => {
    if (chunk.type !== 'iTXt') return false;
    const end = chunk.data.indexOf(0);
    const keyword = new TextDecoder('latin1').decode(end === -1 ? chunk.data : chunk.data.subarray(0, end));
    return keyword === SOURCE_KEYWORD;
  };
  const sources = walk.chunks.filter(isSource);
  if (sources.length !== 1)
    return { ok: false, reason: `Expected exactly one embedded source chunk in the rendered PNG, found ${sources.length}` };
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const chunk of walk.chunks) {
    if (isSource(chunk)) continue;
    parts.push(bytes.subarray(chunk.offset, chunk.offset + 12 + chunk.data.length));
  }
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return { ok: true, bytes: out };
}

function renderFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ExportCoreError) return { code: error.code, message: error.message };
  return { code: 'io-error', message: error instanceof Error ? error.message : String(error) };
}

export async function exportPlainPng(deps: ExportPngDeps, input: ExportPngInput): Promise<ExportPngResult> {
  const { source, width, height } = input;
  let validation: ProfileValidation;
  try {
    validation = await deps.validateProfile(source, width, height);
  } catch (error) {
    const failure = renderFailure(error);
    return { status: 'failed', stage: 'validate', code: failure.code, message: failure.message };
  }

  // Primary route from the validation verdict; the other route is
  // the fallback. The result reports the route that actually
  // produced the raster.
  const routes: Array<'build' | 'convert'> = validation.valid ? ['build', 'convert'] : ['convert', 'build'];
  let rendered: Extract<PlainPngRenderOutcome, { ok: true }> | undefined;
  let renderedVia: 'build' | 'convert' | undefined;
  let primaryFailure: { code: string; message: string } | undefined;
  for (const route of routes) {
    try {
      const outcome = route === 'build'
        ? await deps.renderViaBuild(source, width, height)
        : await deps.renderViaConvert(source);
      if (outcome.ok) { rendered = outcome; renderedVia = route; break; }
      primaryFailure ??= { code: outcome.code, message: outcome.message };
    } catch (error) {
      primaryFailure ??= renderFailure(error);
    }
  }
  if (!rendered || !renderedVia)
    return { status: 'failed', stage: 'render', code: primaryFailure?.code ?? 'unknown', message: primaryFailure?.message ?? 'The Core could not render the source' };

  const stripped = stripSourceChunk(rendered.png);
  if (!stripped.ok) return { status: 'failed', stage: 'strip', code: 'strip-failed', message: stripped.reason };

  let targetPath: string | null;
  try {
    targetPath = await deps.chooseTarget(input.defaultPath);
  } catch (error) {
    const failure = renderFailure(error);
    return { status: 'failed', stage: 'write', code: failure.code, message: failure.message };
  }
  if (targetPath === null) return { status: 'cancelled' };
  try {
    await deps.writeFile(targetPath, stripped.bytes);
  } catch (error) {
    const failure = renderFailure(error);
    return { status: 'failed', stage: 'write', code: failure.code, message: failure.message };
  }
  return {
    status: 'exported',
    targetPath,
    viaNormalization: renderedVia === 'convert',
    warnings: rendered.warnings,
  };
}
