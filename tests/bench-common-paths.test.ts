import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getRepoRoot } from '../bench/common/paths.js';

test('getRepoRoot resolves to the SiftKit repo root (containing the siftkit package.json)', () => {
  const root = getRepoRoot();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'siftkit');
});

test('getRepoRoot does not resolve to the repo parent directory', () => {
  const root = getRepoRoot();
  assert.equal(fs.existsSync(path.join(root, 'bench')), true);
  assert.equal(fs.existsSync(path.join(root, 'src')), true);
});
