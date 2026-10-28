import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBackup, readBackup, deleteBackup, sidecarPath } from '../src/backup.ts';

test('backup round-trips the pending source byte-exactly (BOM/CRLF/Unicode)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-backup-'));
  const original = join(dir, 'doc.png');
  await writeFile(original, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const destination = join(dir, 'backup.bin');
  const source = '﻿<svg>\r\n<text>あ</text>\r\n</svg>';
  await writeBackup(destination, original, { originalUri: 'file:///doc.png', source, savedSource: '<svg/>' });
  assert.deepEqual(await readFile(destination), await readFile(original), 'backup copies the file bytes');
  const data = await readBackup(destination);
  assert.equal(data.source, source);
  assert.equal(data.savedSource, '<svg/>');
  assert.equal(data.originalUri, 'file:///doc.png');
  await deleteBackup(destination);
  await assert.rejects(access(destination));
  await assert.rejects(access(sidecarPath(destination)));
});

test('missing or corrupt sidecar reads as no backup data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpe-backup-'));
  assert.equal(await readBackup(join(dir, 'nope')), undefined);
  const destination = join(dir, 'b.bin');
  await writeFile(sidecarPath(destination), '{not json', 'utf8');
  assert.equal(await readBackup(destination), undefined);
  await writeFile(sidecarPath(destination), JSON.stringify({ source: 42 }), 'utf8');
  assert.equal(await readBackup(destination), undefined);
});
