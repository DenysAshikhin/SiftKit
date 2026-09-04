import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import test from 'node:test';

import { createManagedTempDir } from './helpers/temp-dirs.js';

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
  'tests/helpers/legacy-backend-fixtures.ts',
]);

function listGitOwnedPaths(repoRoot: string): string[] {
  const output = execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...ROOTS,
  ], { cwd: repoRoot, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!Buffer.isBuffer(output)) {
    throw new Error('git ls-files did not return a byte buffer.');
  }
  return [...new Set(output.toString('utf8').split('\0').filter((sourcePath) => sourcePath.length > 0))];
}

function isMissingPathError(error: Error): boolean {
  return 'code' in error && error.code === 'ENOENT';
}

function collectFiles(repoRoot: string): string[] {
  return listGitOwnedPaths(repoRoot)
    .map((sourcePath) => join(repoRoot, sourcePath))
    .filter((sourcePath) => {
      try {
        const fileInfo = lstatSync(sourcePath);
        return fileInfo.isFile() && !fileInfo.isSymbolicLink();
      } catch (error) {
        if (error instanceof Error && isMissingPathError(error)) {
          return false;
        }
        throw error;
      }
    });
}

function findForbiddenReferences(repoRoot: string): string[] {
  return collectFiles(repoRoot)
    .map((sourcePath) => relative(repoRoot, sourcePath).replaceAll('\\', '/'))
    .filter((sourcePath) => !isAllowedPath(sourcePath))
    .filter((sourcePath) => FORBIDDEN_REFERENCE.test(readFileSync(join(repoRoot, sourcePath), 'utf8')));
}

function isAllowedPath(path: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  return normalizedPath.startsWith('src/state/migrations/') || ALLOWED_PATHS.has(normalizedPath);
}

function createGitAuditRepository(): string {
  const repoRoot = createManagedTempDir('siftkit-reference-audit-');
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot, stdio: 'pipe' });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, '.gitignore'), 'src/ignored.ts\n', 'utf8');
  writeFileSync(join(repoRoot, 'src', 'tracked.ts'), 'const tracked = true;\n', 'utf8');
  writeFileSync(join(repoRoot, 'src', 'ignored.ts'), 'const banned = "gguf";\n', 'utf8');
  execFileSync('git', ['add', '--', '.gitignore', 'src/tracked.ts'], { cwd: repoRoot, stdio: 'pipe' });
  writeFileSync(join(repoRoot, 'src', 'untracked.ts'), 'const untracked = true;\n', 'utf8');
  return repoRoot;
}

test('runtime and test trees contain no removed backend references', () => {
  assert.deepEqual(findForbiddenReferences('.'), []);
});

test('reference audit ignores forbidden text in an ignored generated file', () => {
  const repoRoot = createGitAuditRepository();
  const sourcePaths = collectFiles(repoRoot)
    .map((sourcePath) => relative(repoRoot, sourcePath).replaceAll('\\', '/'))
    .sort();

  assert.deepEqual(sourcePaths, ['src/tracked.ts', 'src/untracked.ts']);
});

test('reference audit tolerates a tracked file deleted from the worktree', () => {
  const repoRoot = createGitAuditRepository();
  rmSync(join(repoRoot, 'src', 'tracked.ts'));

  assert.doesNotThrow(() => collectFiles(repoRoot));
});

test('reference audit reports forbidden text in tracked and untracked source files', () => {
  const repoRoot = createGitAuditRepository();
  writeFileSync(join(repoRoot, 'src', 'tracked-offender.ts'), 'const banned = "gguf";\n', 'utf8');
  execFileSync('git', ['add', '--', 'src/tracked-offender.ts'], { cwd: repoRoot, stdio: 'pipe' });
  writeFileSync(join(repoRoot, 'src', 'untracked-offender.ts'), 'const banned = "llama";\n', 'utf8');

  assert.deepEqual(findForbiddenReferences(repoRoot).sort(), [
    'src/tracked-offender.ts',
    'src/untracked-offender.ts',
  ]);
});

test('reference audit exempts only the migration tree and named legacy fixture helper', () => {
  const repoRoot = createGitAuditRepository();
  const migrationFixture = join(repoRoot, 'src', 'state', 'migrations', 'legacy-fixture.ts');
  const legacyHelper = join(repoRoot, 'tests', 'helpers', 'legacy-backend-fixtures.ts');
  const unrelatedHelper = join(repoRoot, 'tests', 'helpers', 'other-fixtures.ts');
  mkdirSync(join(repoRoot, 'src', 'state', 'migrations'), { recursive: true });
  mkdirSync(join(repoRoot, 'tests', 'helpers'), { recursive: true });
  writeFileSync(migrationFixture, 'const historical = "llama";\n', 'utf8');
  writeFileSync(legacyHelper, 'const historical = "gguf";\n', 'utf8');
  writeFileSync(unrelatedHelper, 'const unexpected = "llama";\n', 'utf8');
  execFileSync('git', ['add', '--', 'src/state/migrations/legacy-fixture.ts', 'tests/helpers/legacy-backend-fixtures.ts', 'tests/helpers/other-fixtures.ts'], { cwd: repoRoot, stdio: 'pipe' });

  assert.deepEqual(findForbiddenReferences(repoRoot), ['tests/helpers/other-fixtures.ts']);
});
