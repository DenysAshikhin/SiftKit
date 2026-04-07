import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getRepoSearchFailedDirectory,
  getRepoSearchLogRoot,
  getRepoSearchSuccessfulDirectory,
} from '../config/paths.js';
import { createTracer } from '../lib/trace.js';
import type { JsonLogger } from './types.js';

export const traceRepoSearch = createTracer('SIFTKIT_TRACE_REPO_SEARCH', 'repo-search');

export function ensureRepoSearchLogFolders(): {
  root: string;
  successful: string;
  failed: string;
} {
  const root = getRepoSearchLogRoot();
  const successful = getRepoSearchSuccessfulDirectory();
  const failed = getRepoSearchFailedDirectory();
  fs.mkdirSync(successful, { recursive: true });
  fs.mkdirSync(failed, { recursive: true });
  return { root, successful, failed };
}

export function moveFileSafe(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch {
    // Fall through to copy+delete for cross-volume moves.
  }
  fs.copyFileSync(sourcePath, targetPath);
  fs.unlinkSync(sourcePath);
}

export function createJsonLogger(logPath: string): JsonLogger {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '', 'utf8');
  return {
    path: logPath,
    write(event: Record<string, unknown>): void {
      fs.appendFileSync(
        logPath,
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        'utf8'
      );
    },
  };
}
