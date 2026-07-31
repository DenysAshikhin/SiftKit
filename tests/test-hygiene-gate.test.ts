import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TESTS_DIR = __dirname;

function listTestSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(TESTS_DIR);
  return out;
}

function filesMatching(pattern: RegExp): string[] {
  return listTestSources().filter((file) => pattern.test(fs.readFileSync(file, 'utf8')));
}

test('hygiene: there is at least one test source to scan', () => {
  assert.ok(listTestSources().length > 0);
});

test('hygiene: no test imports from ../dist', () => {
  assert.deepEqual(filesMatching(/from ['"]\.\.\/dist/), []);
});

// The needle is built from fragments so this gate file does not match itself.
test('hygiene: no test file disables type checking', () => {
  assert.deepEqual(filesMatching(new RegExp('@ts' + '-nocheck')), []);
});

// Temp directories must come from the registry in tests/helpers/temp-dirs.ts, which removes
// them in a process exit handler. A bare call depends on the test remembering to clean up,
// and 42 such calls in one file with 3 cleanups is how ~58,000 directories accumulated.
// The needle is built from fragments so this gate file does not match itself.
test('hygiene: no test creates a temp directory outside the managed registry', () => {
  const allowed = new Set([
    path.join(TESTS_DIR, 'helpers', 'temp-dirs.ts'),
    path.join(TESTS_DIR, 'temp-dirs.test.ts'),
  ]);
  const offenders = filesMatching(new RegExp('mkdtemp' + 'Sync')).filter(
    (file) => !allowed.has(file),
  );
  assert.deepEqual(offenders, []);
});
