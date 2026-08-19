import fs from 'node:fs';
import path from 'node:path';

import type { TempArchive } from '../../src/assistant/control/temp-archive.js';
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
