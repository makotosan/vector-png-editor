// Backup persistence for hot-exit recovery (P2-05), framework-free.
// A backup is a byte copy of the document file at the backup
// destination, plus a JSON sidecar (`<destination>.vpe.json`) holding
// the pending (possibly unsaved) source and the last saved source, so
// a restore reopens with unsaved edits intact and byte-exact.
import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';

export type BackupData = {
  originalUri: string;
  source: string;
  savedSource: string;
};

export function sidecarPath(destination: string): string {
  return destination + '.vpe.json';
}

export async function writeBackup(destination: string, originalFile: string, data: BackupData): Promise<void> {
  await copyFile(originalFile, destination);
  await writeFile(sidecarPath(destination), JSON.stringify(data), 'utf8');
}

export async function readBackup(destination: string): Promise<BackupData | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(destination), 'utf8')) as Partial<BackupData>;
    if (typeof parsed.originalUri !== 'string' || typeof parsed.source !== 'string' || typeof parsed.savedSource !== 'string')
      return undefined;
    return { originalUri: parsed.originalUri, source: parsed.source, savedSource: parsed.savedSource };
  } catch {
    return undefined;
  }
}

export async function deleteBackup(destination: string): Promise<void> {
  await unlink(destination).catch(() => undefined);
  await unlink(sidecarPath(destination)).catch(() => undefined);
}
