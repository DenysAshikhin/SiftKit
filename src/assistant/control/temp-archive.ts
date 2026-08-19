import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ZipFileWriter } from '../../lib/zip-file-writer.js';

const ARCHIVE_FILE_NAME = 'archive.zip';

/**
 * A finished archive sitting in a private temp directory. The caller owns it: stream it, then
 * call `cleanup` — which is idempotent — from a `finally` so a failed or abandoned response
 * never leaves the bytes behind.
 */
export interface TempArchive {
  readonly path: string;
  cleanup(): void;
}

/**
 * Builds a zip inside its own temp directory so the whole archive never has to be held in
 * memory. `cleanup` removes the directory whether the build finished or threw, which is why
 * every intermediate file belongs in `scratchPath` rather than somewhere else in `os.tmpdir()`.
 */
export class TempArchiveBuilder {
  readonly writer: ZipFileWriter;
  private readonly directory: string;
  private readonly archivePath: string;

  constructor(prefix: string) {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.archivePath = path.join(this.directory, ARCHIVE_FILE_NAME);
    this.writer = new ZipFileWriter(this.archivePath);
  }

  /** A path for an intermediate file, inside the directory `cleanup` already covers. */
  scratchPath(name: string): string {
    return path.join(this.directory, name);
  }

  finish(): TempArchive {
    this.writer.finish();
    const directory = this.directory;
    return {
      path: this.archivePath,
      cleanup(): void {
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  }

  /** Closes the writer and removes the directory. Safe before or after `finish`. */
  cleanup(): void {
    this.writer.abort();
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
