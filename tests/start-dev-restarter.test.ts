import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { isSourceChange, readStamp } from '../scripts/start-dev-restarter.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const STARTED_AT_MS = 1_000_000;
const KNOWN = { mtimeMs: 500_000, size: 10 };

test('an edit to a known source file is a change; an identical stamp is not', () => {
  assert.equal(isSourceChange(KNOWN, KNOWN, STARTED_AT_MS), false);
  assert.equal(isSourceChange(KNOWN, { ...KNOWN, mtimeMs: KNOWN.mtimeMs + 1 }, STARTED_AT_MS), true);
  assert.equal(isSourceChange(KNOWN, { ...KNOWN, size: KNOWN.size + 1 }, STARTED_AT_MS), true);
});

test('deleting a known source file is a change; a vanished unknown file is not', () => {
  assert.equal(isSourceChange(KNOWN, null, STARTED_AT_MS), true);
  assert.equal(isSourceChange(undefined, null, STARTED_AT_MS), false);
});

test('an unknown file counts only when it was written after watching started', () => {
  assert.equal(isSourceChange(undefined, { mtimeMs: STARTED_AT_MS + 1, size: 1 }, STARTED_AT_MS), true);
  assert.equal(isSourceChange(undefined, { mtimeMs: STARTED_AT_MS, size: 1 }, STARTED_AT_MS), false);
});

// Windows writes a stale last-access time when a module is lazily read; fs.watch reports it as a change.
test('a last-access-only touch of a real file leaves its stamp unchanged', () => {
  const file = path.join(createManagedTempDir('siftkit-restarter-stamp-'), 'module.ts');
  fs.writeFileSync(file, 'export const value = 1;\n');
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  const before = readStamp(file);
  assert.ok(before);
  fs.utimesSync(file, 1_800_000_000, 1_700_000_000);
  assert.equal(isSourceChange(before, readStamp(file), Date.now()), false);
  fs.writeFileSync(file, 'export const value = 2;\n');
  assert.equal(isSourceChange(before, readStamp(file), Date.now()), true);
  fs.rmSync(file);
  assert.equal(readStamp(file), null);
});
