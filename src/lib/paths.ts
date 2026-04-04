import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonText } from './json.js';

export function normalizeWindowsPath(value: string): string {
  return value.replace(/\//gu, '\\').toLowerCase();
}

/**
 * Walks upward from `startPath` looking for a `package.json` whose `name` is
 * `"siftkit"`. Returns the directory that contains it, or `null` when no
 * SiftKit repo root is reachable.
 */
export function findNearestSiftKitRepoRoot(startPath: string = process.cwd()): string | null {
  let currentPath = path.resolve(startPath);
  for (;;) {
    const packagePath = path.join(currentPath, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const parsed = parseJsonText<{ name?: unknown }>(fs.readFileSync(packagePath, 'utf8'));
        if (parsed?.name === 'siftkit') {
          return currentPath;
        }
      } catch {
        // Ignore malformed package.json files while walking upward.
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

export function resolvePathFromBase(targetPath: string, baseDirectory: string): string {
  if (!targetPath.trim()) {
    throw new Error('Path value cannot be empty.');
  }

  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(baseDirectory, targetPath);
}

export function resolveOptionalPathFromBase(
  targetPath: string | null | undefined,
  baseDirectory: string
): string | null {
  if (targetPath === null || targetPath === undefined || !String(targetPath).trim()) {
    return null;
  }

  return resolvePathFromBase(String(targetPath).trim(), baseDirectory);
}
