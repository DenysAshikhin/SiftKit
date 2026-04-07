/**
 * Delete old logs from the .siftkit/logs directory.
 *
 * Usage:
 *   tsx scripts/delete-logs.ts            # delete logs older than 7 days
 *   tsx scripts/delete-logs.ts --days 3   # delete logs older than N days
 *   tsx scripts/delete-logs.ts --all      # delete all logs regardless of age
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRuntimeRoot } from '../src/config/paths.js';

// ---------------------------------------------------------------------------
// Recursive file walker
// ---------------------------------------------------------------------------

function walkFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of walkFiles(full)) {
        files.push(nested);
      }
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Remove empty directories (bottom-up)
// ---------------------------------------------------------------------------

function pruneEmptyDirs(dir: string, root: string): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removed += pruneEmptyDirs(path.join(dir, entry.name), root);
    }
  }
  // Re-check after children may have been removed
  if (dir !== root) {
    try {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
        removed += 1;
      }
    } catch { /* ignore */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Age check
// ---------------------------------------------------------------------------

function isOlderThan(filePath: string, thresholdMs: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtimeMs < thresholdMs;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const deleteAll = args.includes('--all');
const daysIndex = args.indexOf('--days');
const days = daysIndex !== -1 ? Number.parseInt(args[daysIndex + 1] ?? '7', 10) : 7;

if (!deleteAll && (!Number.isFinite(days) || days < 0)) {
  process.stderr.write(`[delete-logs] Invalid --days value: ${args[daysIndex + 1]}\n`);
  process.exit(1);
}

const logsPath = path.join(getRuntimeRoot(), 'logs');

if (!fs.existsSync(logsPath)) {
  process.stdout.write(`[delete-logs] Logs directory does not exist: ${logsPath}\n`);
  process.exit(0);
}

const thresholdMs = deleteAll ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;
const label = deleteAll ? 'all logs' : `logs older than ${days} day${days === 1 ? '' : 's'}`;

process.stdout.write(`[delete-logs] Scanning ${logsPath} (${label})\n`);

const allFiles = walkFiles(logsPath);
let deletedFiles = 0;
let skipped = 0;

for (const filePath of allFiles) {
  if (!deleteAll && !isOlderThan(filePath, thresholdMs)) {
    skipped += 1;
    continue;
  }
  try {
    fs.unlinkSync(filePath);
    deletedFiles += 1;
  } catch {
    // File may be locked by a running process — skip silently
    skipped += 1;
  }
}

const prunedDirs = pruneEmptyDirs(logsPath, logsPath);

process.stdout.write(
  `[delete-logs] Done. Deleted ${deletedFiles} file(s), removed ${prunedDirs} empty director${prunedDirs === 1 ? 'y' : 'ies'}. Skipped ${skipped} item(s).\n`
);
