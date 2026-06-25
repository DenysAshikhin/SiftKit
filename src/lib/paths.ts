import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from './zod.js';

const PackageJsonNameSchema = z.object({ name: z.string().optional() });

export function normalizeWindowsPath(value: string): string {
  return value.replace(/\//gu, '\\').toLowerCase();
}

/**
 * Walks upward from `startPath` looking for a `package.json` whose `name` is
 * `"siftkit"`. Returns the directory that contains it, or `null` when no
 * SiftKit repo root is reachable.
 */
export function findNearestSiftKitRepoRoot(startPath: string = process.cwd()): string | null {
  let currentPath = resolve(startPath);
  for (;;) {
    const packagePath = resolve(currentPath, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const parsed = PackageJsonNameSchema.parse(JSON.parse(readFileSync(packagePath, 'utf8')));
        if (parsed?.name === 'siftkit') {
          return currentPath;
        }
      } catch {
        // Ignore malformed package.json files while walking upward.
      }
    }

    const parentPath = dirname(currentPath);
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

  return isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(baseDirectory, targetPath);
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
