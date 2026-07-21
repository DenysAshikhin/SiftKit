import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from './zod.js';

const PackageJsonNameSchema = z.object({ name: z.string().optional() });

/**
 * ESM-safe replacement for the CommonJS `__filename`. The compiled `dist/**`
 * runs as ES modules (no `type: commonjs`), where `__filename`/`__dirname` do
 * not exist. Pass `import.meta.url` from the calling module.
 */
export function moduleFilename(moduleUrl: string): string {
  return fileURLToPath(moduleUrl);
}

/** ESM-safe replacement for the CommonJS `__dirname`. Pass `import.meta.url`. */
export function moduleDirname(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}

/**
 * ESM-safe replacement for the CommonJS `require.main === module` direct-run
 * check. Returns true when the module identified by `moduleUrl` is the process
 * entry point. Pass `import.meta.url`.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  return moduleUrl === pathToFileURL(entryPath).href;
}

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
