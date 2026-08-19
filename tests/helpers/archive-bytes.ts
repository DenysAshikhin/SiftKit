import fs from 'node:fs';

import type { TempArchive } from '../../src/assistant/control/temp-archive.js';

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
