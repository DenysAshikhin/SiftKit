import fs from 'node:fs';
import path from 'node:path';

/**
 * Removes leftover `siftkit-*` directories from the OS temp dir. The suite leaked ~113 per run
 * before the registry landed; this clears whatever accumulated (58,510 as of 2026-07-31).
 *
 * Only directories whose name starts with `siftkit-` are touched, never the production
 * `siftkit-temp-timing` trace directory, and by default only those untouched for an hour, so a
 * concurrent test run is never disturbed.
 */
const PREFIX = 'siftkit-';
const RESERVED = 'siftkit-temp-timing';
const DEFAULT_MIN_AGE_MINUTES = 60;

export interface PurgeResult {
  removed: number;
  skipped: number;
  failed: number;
}

export function parseMinAgeMinutes(argv: string[]): number {
  const index = argv.indexOf('--min-age-minutes');
  if (index === -1) {
    return DEFAULT_MIN_AGE_MINUTES;
  }
  const raw = argv[index + 1];
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --min-age-minutes value: ${raw}`);
  }
  return parsed;
}

export function purgeTempDirectories(root: string, cutoffMs: number): PurgeResult {
  const result: PurgeResult = { removed: 0, skipped: 0, failed: 0 };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) {
      continue;
    }
    if (entry.name === RESERVED) {
      result.skipped += 1;
      continue;
    }
    const directory = path.join(root, entry.name);
    try {
      if (fs.statSync(directory).mtimeMs > cutoffMs) {
        result.skipped += 1;
        continue;
      }
    } catch {
      result.skipped += 1;
      continue;
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
