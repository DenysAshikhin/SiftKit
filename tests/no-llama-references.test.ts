import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const ROOTS = [
  'src',
  'packages',
  'dashboard/src',
  'dashboard/tests',
  'tests',
  'scripts',
  'bench',
  'eval',
] as const;

const FORBIDDEN_REFERENCE = /(?<!ex)llama|gguf/iu;
const ALLOWED_PATHS = new Set([
  'tests/no-llama-references.test.ts',
]);

function collectFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name);
    return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
  });
}

function isAllowedPath(path: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  return normalizedPath.startsWith('src/state/migrations/') || ALLOWED_PATHS.has(normalizedPath);
}

test('runtime and test trees contain no removed backend references', () => {
  const offenders = ROOTS.flatMap((root) => collectFiles(root))
    .map((path) => relative('.', path).replaceAll('\\', '/'))
    .filter((path) => !isAllowedPath(path))
    .filter((path) => FORBIDDEN_REFERENCE.test(readFileSync(path, 'utf8')));

  assert.deepEqual(offenders, []);
});
