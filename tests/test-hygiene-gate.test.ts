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

// Enabled in Phase 6 (flip skip -> active).
test('hygiene: no test imports from ../dist', { skip: true }, () => {
  assert.deepEqual(filesMatching(/from ['"]\.\.\/dist/), []);
});

test('hygiene: no test file uses @ts-nocheck', { skip: true }, () => {
  assert.deepEqual(filesMatching(/@ts-nocheck/), []);
});
