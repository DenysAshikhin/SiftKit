import * as fs from 'node:fs';
import * as path from 'node:path';
import { ONE_WEEK_MS } from './types.js';

export function isLauncherLogFile(fileName: string): boolean {
  return /^launcher_.*_(stdout|stderr)\.log$/u.test(fileName);
}

export function collectLauncherLogPaths(rootDirectory: string): string[] {
  const pending = [rootDirectory];
  const launcherLogPaths: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile() && isLauncherLogFile(entry.name)) {
        launcherLogPaths.push(entryPath);
      }
    }
  }

  return launcherLogPaths;
}

export function pruneOldLauncherLogs(rootDirectory: string, nowMs = Date.now()): number {
  const launcherLogPaths = collectLauncherLogPaths(rootDirectory);
  let deletedCount = 0;
  for (const logPath of launcherLogPaths) {
    try {
      const stat = fs.statSync(logPath);
      if (nowMs - stat.mtimeMs <= ONE_WEEK_MS) {
        continue;
      }
      fs.unlinkSync(logPath);
      deletedCount += 1;
    } catch {
      continue;
    }
  }

  return deletedCount;
}
