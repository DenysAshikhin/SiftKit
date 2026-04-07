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
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Resolve .siftkit/logs path
// ---------------------------------------------------------------------------

function getSiftKitLogsPath(): string {
  const repoRoot = path.resolve(import.meta.dirname ?? __dirname, '..');
  const repoLocal = path.join(repoRoot, '.siftkit', 'logs');
  if (fs.existsSync(repoLocal)) {
    return repoLocal;
  }
  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) {
    const userLocal = path.join(userProfile, '.siftkit', 'logs');
    if (fs.existsSync(userLocal)) {
      return userLocal;
    }
  }
  // Fall back to repo-local even if it doesn't exist yet
  return repoLocal;
}

// ---------------------------------------------------------------------------
// File/directory enumeration
// ---------------------------------------------------------------------------

function collectEntries(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    paths.push(path.join(dir, entry.name));
    if (entry.isDirectory()) {
      for (const nested of collectEntries(path.join(dir, entry.name))) {
        paths.push(nested);
      }
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Deletion helpers
// ---------------------------------------------------------------------------

function deleteEntry(entryPath: string): boolean {
  try {
    fs.rmSync(entryPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function isOlderThan(entryPath: string, thresholdMs: number): boolean {
  try {
    const stat = fs.statSync(entryPath);
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

const logsPath = getSiftKitLogsPath();

if (!fs.existsSync(logsPath)) {
  process.stdout.write(`[delete-logs] Logs directory does not exist: ${logsPath}\n`);
  process.exit(0);
}

const thresholdMs = deleteAll ? Date.now() + 1 : Date.now() - days * 24 * 60 * 60 * 1000;
const label = deleteAll ? 'all logs' : `logs older than ${days} day${days === 1 ? '' : 's'}`;

process.stdout.write(`[delete-logs] Scanning ${logsPath} (${label})\n`);

// Collect top-level entries inside logs/ (each is either a file or a session directory)
let topEntries: fs.Dirent[];
try {
  topEntries = fs.readdirSync(logsPath, { withFileTypes: true });
} catch (error) {
  process.stderr.write(`[delete-logs] Failed to read logs directory: ${(error as Error).message}\n`);
  process.exit(1);
}

let deletedFiles = 0;
let deletedDirs = 0;
let skipped = 0;

for (const entry of topEntries) {
  const entryPath = path.join(logsPath, entry.name);

  if (entry.isDirectory()) {
    // For subdirectories (requests, failed, abandoned, repo_search, managed-llama),
    // recurse into them and delete individual items that are old enough.
    let subEntries: fs.Dirent[];
    try {
      subEntries = fs.readdirSync(entryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      const subPath = path.join(entryPath, sub.name);
      if (!isOlderThan(subPath, thresholdMs)) {
        skipped += 1;
        continue;
      }
      if (deleteEntry(subPath)) {
        if (sub.isDirectory()) {
          deletedDirs += 1;
        } else {
          deletedFiles += 1;
        }
      }
    }
  } else if (entry.isFile()) {
    if (!isOlderThan(entryPath, thresholdMs)) {
      skipped += 1;
      continue;
    }
    if (deleteEntry(entryPath)) {
      deletedFiles += 1;
    }
  }
}

process.stdout.write(
  `[delete-logs] Done. Deleted ${deletedFiles} file(s), ${deletedDirs} director${deletedDirs === 1 ? 'y' : 'ies'}. Skipped ${skipped} recent item(s).\n`
);
