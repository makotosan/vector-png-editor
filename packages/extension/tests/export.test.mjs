import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSvgAsVectorPng, ExportUnavailableError } from '../src/export.ts';
import { createCoreExportDeps } from '../src/coreExport.ts';
import { createTsCoreRuntime } from '../src/tsCore.ts';
import { loadHostFonts } from '../src/hostFonts.ts';
import { extractSource } from '../src/extract.ts';

const VALID = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';
const STYLED = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><style>.a{fill:red}</style><rect class="a" width="8" height="8"/></svg>';
const DIAGNOSTICS = [{
  severity: 'error', code: 'unsupported-element', element: 'style', attribute: null,
  line: 1, column: 64, message: 'Unsupported SVG element: style', suggestion: 'set presentation attributes directly',
}];

// In-memory file system + recording fakes for every export dependency.
function fakeDeps(overrides = {}) {
  const files = new Map(); // path -> content marker
  const calls = { build: [], convert: [], present: [], confirm: 0 };
  const deps = {
    files, calls,
    validateProfile: async () => ({ valid: true }),
    build: async (request) => {
      calls.build.push(request);
      files.set(request.output, 'built-png');
      return { ok: true, backup: null };
    },
    convert: async (request) => {
      calls.convert.push(request);
      files.set(request.output, 'converted-png');
      return { ok: true, warnings: [] };
    },
    sha256File: async (path) => `sha:${files.get(path)}`,
    targetExists: async (path) => files.has(path),
    renameFile: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    removeFile: async (path) => { files.delete(path); },
    confirmOverwrite: async () => { calls.confirm++; return true; },
    presentDiagnostics: async (diagnostics) => { calls.present.push(diagnostics); return 'cancel'; },
    ...overrides,
  };
  return deps;
}

const input = (overrides = {}) => ({
  source: VALID, targetPath: '/work/doc.png', width: 8, height: 8, ...overrides,
});

test('valid source builds to the sibling PNG with no overwrite token', async () => {
  const deps = fakeDeps();
  const result = await exportSvgAsVectorPng(deps, input());
  assert.deepEqual(result, { status: 'exported', via: 'build', targetPath: '/work/doc.png', warnings: [] });
  assert.equal(deps.calls.build.length, 1);
  assert.equal(deps.calls.build[0].output, '/work/doc.png');
  assert.equal(deps.calls.build[0].expectedSha256, undefined);
  assert.equal(deps.calls.convert.length, 0);
  assert.equal(deps.files.get('/work/doc.png'), 'built-png');
});

test('invalid source writes nothing and returns the diagnostics', async () => {
  const deps = fakeDeps({
    validateProfile: async () => ({ valid: false, diagnostics: DIAGNOSTICS }),
  });
  const result = await exportSvgAsVectorPng(deps, input({ source: STYLED }));
  assert.deepEqual(result, { status: 'invalid', diagnostics: DIAGNOSTICS });
  assert.deepEqual(deps.calls.present, [DIAGNOSTICS], 'the structured diagnostics are presented verbatim');
  assert.equal(deps.calls.build.length, 0);
  assert.equal(deps.calls.convert.length, 0);
  assert.equal(deps.files.size, 0, 'no file was created, moved or deleted');
});

test('declined overwrite writes nothing on the build route', async () => {
  const deps = fakeDeps({ confirmOverwrite: async () => false });
  deps.files.set('/work/doc.png', 'existing-png');
  const result = await exportSvgAsVectorPng(deps, input());
  assert.deepEqual(result, { status: 'cancelled-overwrite', targetPath: '/work/doc.png' });
  assert.equal(deps.calls.build.length, 0);
  assert.equal(deps.files.get('/work/doc.png'), 'existing-png');
});

test('confirmed overwrite builds under the existing target revision token', async () => {
  const deps = fakeDeps();
  deps.files.set('/work/doc.png', 'plain-png-bytes');
  const result = await exportSvgAsVectorPng(deps, input());
  assert.equal(result.status, 'exported');
  assert.equal(deps.calls.build[0].expectedSha256, 'sha:plain-png-bytes');
});

test('normalization runs only after the explicit choice and surfaces warnings', async () => {
  const deps = fakeDeps({
    validateProfile: async () => ({ valid: false, diagnostics: DIAGNOSTICS }),
    presentDiagnostics: async () => 'normalize',
    convert: async (request) => {
      deps.calls.convert.push(request);
      deps.files.set(request.output, 'converted-png');
      return { ok: true, warnings: ['Accessibility: role "img" could not be preserved (unsupported-semantics)'] };
    },
  });
  const result = await exportSvgAsVectorPng(deps, input({ source: STYLED }));
  assert.equal(result.status, 'exported');
  assert.equal(result.via, 'convert');
  assert.deepEqual(result.warnings, ['Accessibility: role "img" could not be preserved (unsupported-semantics)']);
  assert.equal(deps.calls.build.length, 0);
});

test('failed conversion restores the pre-existing target verbatim', async () => {
  const deps = fakeDeps({
    validateProfile: async () => ({ valid: false, diagnostics: DIAGNOSTICS }),
    presentDiagnostics: async () => 'normalize',
    convert: async (request) => {
      deps.calls.convert.push(request);
      deps.files.set(request.output, 'partial-output');
      return { ok: false, code: 'unsupported-css', message: 'letter-spacing is not supported' };
    },
  });
  deps.files.set('/work/doc.png', 'previous-png');
  const result = await exportSvgAsVectorPng(deps, input({ source: STYLED }));
  assert.deepEqual(result, { status: 'failed', stage: 'convert', code: 'unsupported-css', message: 'letter-spacing is not supported' });
  assert.equal(deps.files.get('/work/doc.png'), 'previous-png', 'the original target is restored');
  assert.deepEqual([...deps.files.keys()], ['/work/doc.png'], 'no partial output or backup copy remains');
});

test('successful conversion over an existing target removes the aside copy', async () => {
  const deps = fakeDeps({
    validateProfile: async () => ({ valid: false, diagnostics: DIAGNOSTICS }),
    presentDiagnostics: async () => 'normalize',
  });
  deps.files.set('/work/doc.png', 'previous-png');
  const result = await exportSvgAsVectorPng(deps, input({ source: STYLED }));
  assert.equal(result.status, 'exported');
  assert.equal(deps.files.get('/work/doc.png'), 'converted-png');
  assert.deepEqual([...deps.files.keys()], ['/work/doc.png'], 'the aside copy is gone');
});

test('declined overwrite on the normalization route also writes nothing', async () => {
  const deps = fakeDeps({
    validateProfile: async () => ({ valid: false, diagnostics: DIAGNOSTICS }),
    presentDiagnostics: async () => 'normalize',
    confirmOverwrite: async () => false,
  });
  deps.files.set('/work/doc.png', 'previous-png');
  const result = await exportSvgAsVectorPng(deps, input({ source: STYLED }));
  assert.equal(result.status, 'cancelled-overwrite');
  assert.equal(deps.calls.convert.length, 0);
  assert.equal(deps.files.get('/work/doc.png'), 'previous-png');
});

test('an unreachable Core fails at the validate stage and writes nothing', async () => {
  const deps = fakeDeps({
    validateProfile: async () => { throw new ExportUnavailableError('no python'); },
  });
  const result = await exportSvgAsVectorPng(deps, input());
  assert.deepEqual(result, { status: 'failed', stage: 'validate', code: 'unavailable', message: 'no python' });
  assert.equal(deps.files.size, 0);
});

test('a build conflict surfaces as a failure, not a silent overwrite', async () => {
  const deps = fakeDeps({
    build: async () => ({ ok: false, code: 'conflict', message: 'destination changed' }),
  });
  deps.files.set('/work/doc.png', 'existing-png');
  const result = await exportSvgAsVectorPng(deps, input());
  assert.deepEqual(result, { status: 'failed', stage: 'build', code: 'conflict', message: 'destination changed' });
});

// Integration: validate, build and the normalization route all
// run in-process on the TypeScript Core (Issues #58 and #59), so
// every route is tested by default and no test in this suite is
// Python-gated any more. (The Python environment machinery's own
// tests - discovery, managed env - use fakes and run by default
// too; the machinery itself is Phase 3's to remove.)
const runtime = createTsCoreRuntime({ fonts: loadHostFonts() });

test('TS Core: valid source exports a vector-png that round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-export-'));
  const target = join(dir, 'doc.png');
  const deps = {
    ...createCoreExportDeps(runtime),
    confirmOverwrite: async () => true,
    presentDiagnostics: async () => 'cancel',
  };
  const result = await exportSvgAsVectorPng(deps, { source: VALID, targetPath: target, width: 8, height: 8 });
  assert.equal(result.status, 'exported', JSON.stringify(result));
  assert.equal(result.via, 'build');
  assert.equal(extractSource(await readFile(target)).text, VALID);
});

test('styled source exports via normalization (TS Core convert) and the source is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-export-'));
  const sourcePath = join(dir, 'doc.svg');
  await writeFile(sourcePath, STYLED, 'utf8');
  const target = join(dir, 'doc.png');
  let presented = 0;
  const deps = {
    ...createCoreExportDeps(runtime),
    confirmOverwrite: async () => true,
    presentDiagnostics: async (diagnostics) => {
      presented = diagnostics.length;
      assert.ok(diagnostics.some((d) => d.code === 'unsupported-element' && d.element === 'style'));
      return 'normalize';
    },
  };
  const result = await exportSvgAsVectorPng(deps, { source: STYLED, targetPath: target, width: 8, height: 8 });
  assert.equal(result.status, 'exported', JSON.stringify(result));
  assert.equal(result.via, 'convert');
  assert.ok(presented > 0, 'profile diagnostics were presented before normalizing');
  await access(target);
  const embedded = extractSource(await readFile(target)).text;
  assert.ok(!embedded.includes('<style'), 'the exported source is the normalized form');
  assert.equal(await readFile(sourcePath, 'utf8'), STYLED, 'the source file was never modified');
});
