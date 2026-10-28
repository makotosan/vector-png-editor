import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSvgPreviewRenderer } from '../src/svgPreview.ts';
import { PreviewInvalidError } from '../src/preview.ts';

test('edited preview writes the current source as-is to a private file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-svg-preview-'));
  const render = createSvgPreviewRenderer({ previewDir: dir, documentKey: 'abc123' });
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><rect class="a"/></svg>';
  const path = await render(source, 1);
  assert.match(path, /preview-abc123-1\.svg$/);
  assert.equal(await readFile(path, 'utf8'), source, 'non-conforming source renders for viewing, unmodified');
  const second = await render(source.replace('red', 'blue'), 2);
  assert.notEqual(second, path);
  assert.match(await readFile(second, 'utf8'), /blue/);
});

test('a source without an svg root is an invalid preview, not a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-svg-preview-'));
  const render = createSvgPreviewRenderer({ previewDir: dir, documentKey: 'abc123' });
  await assert.rejects(render('plain text, still editable', 1), PreviewInvalidError);
});
