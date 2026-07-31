import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createManagedTempDir } from './helpers/temp-dirs.js';
import { parseMinAgeMinutes, purgeTempDirectories } from '../scripts/purge-temp-dirs.js';

test('parseMinAgeMinutes defaults to 60 and reads an explicit value', () => {
  assert.equal(parseMinAgeMinutes([]), 60);
  assert.equal(parseMinAgeMinutes(['--min-age-minutes', '0']), 0);
  assert.equal(parseMinAgeMinutes(['--min-age-minutes', '5']), 5);
});

test('parseMinAgeMinutes rejects a missing or nonsensical value', () => {
  assert.throws(() => parseMinAgeMinutes(['--min-age-minutes']), /Invalid --min-age-minutes/u);
  assert.throws(() => parseMinAgeMinutes(['--min-age-minutes', 'soon']), /Invalid --min-age-minutes/u);
  assert.throws(() => parseMinAgeMinutes(['--min-age-minutes', '-1']), /Invalid --min-age-minutes/u);
});

test('purgeTempDirectories removes only old siftkit directories', () => {
  const root = createManagedTempDir('siftkit-purge-root-');
  const stale = path.join(root, 'siftkit-stale-abc123');
  const fresh = path.join(root, 'siftkit-fresh-abc123');
  const foreign = path.join(root, 'other-tool-abc123');
  const reserved = path.join(root, 'siftkit-temp-timing');
  for (const directory of [stale, fresh, foreign, reserved]) {
    fs.mkdirSync(directory);
  }
  fs.writeFileSync(path.join(root, 'siftkit-loose-file.txt'), 'x', 'utf8');
  const old = new Date(2020, 0, 1);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(reserved, old, old);

  const result = purgeTempDirectories(root, Date.now() - 60_000);

  // Skipped counts only siftkit-prefixed directories: the fresh one and the reserved
  // production trace dir. Foreign directories and loose files are not siftkit's to count.
  assert.deepEqual(result, { removed: 1, skipped: 2, failed: 0 });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.existsSync(reserved), true);
});
