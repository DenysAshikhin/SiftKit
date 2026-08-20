import fs from 'node:fs';
import path from 'node:path';

import type { TempArchive } from '../../src/assistant/control/temp-archive.js';
import { ZipFileReader } from '../../src/lib/zip-file-reader.js';
import { createManagedTempDir } from './temp-dirs.js';

/**
 * Backup and export stream to a temp file. Tests assert on bytes, so this is the one boundary
 * that reads the archive back — and always cleans it up, which keeps the suite honest about
 * services that are supposed to leave nothing behind.
 */
export async function archiveBytes(archive: Promise<TempArchive>): Promise<Buffer> {
  const finished = await archive;
  try {
    return fs.readFileSync(finished.path);
  } finally {
    finished.cleanup();
  }
}

let uploadCounter = 0;

/**
 * Restore now takes an upload path, not bytes. Tests that build or tamper with archive bytes
 * park them here — in a managed temp directory, so nothing survives the test process.
 */
export function archiveUploadPath(bytes: Buffer): string {
  uploadCounter += 1;
  const uploadPath = path.join(
    createManagedTempDir('siftkit-test-upload-'),
    `upload-${uploadCounter}.zip`,
  );
  fs.writeFileSync(uploadPath, bytes);
  return uploadPath;
}

/** Every entry of an on-disk archive, for tests that assert on contents. */
export async function readArchiveEntries(archivePath: string): Promise<Map<string, Buffer>> {
  const reader = await ZipFileReader.open(archivePath);
  try {
    const entries = new Map<string, Buffer>();
    for (const name of reader.entryNames()) {
      entries.set(name, reader.readEntry(name));
    }
    return entries;
  } finally {
    await reader.close();
  }
}

/** Reads a streamed archive's entries and cleans the archive up, the common assertion shape. */
export async function archiveEntries(archive: Promise<TempArchive>): Promise<Map<string, Buffer>> {
  const finished = await archive;
  try {
    return await readArchiveEntries(finished.path);
  } finally {
    finished.cleanup();
  }
}

/** For tests holding raw bytes (an HTTP response body) rather than a path. */
export function readArchiveEntriesFromBytes(bytes: Buffer): Promise<Map<string, Buffer>> {
  return readArchiveEntries(archiveUploadPath(bytes));
}
