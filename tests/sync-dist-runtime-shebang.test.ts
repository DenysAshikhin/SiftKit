import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureCliShebang } from '../scripts/sync-dist-runtime.js';

test('ensureCliShebang prepends the node shebang exactly once', () => {
  const distRoot = mkdtempSync(join(tmpdir(), 'siftkit-shebang-'));
  mkdirSync(join(distRoot, 'cli'), { recursive: true });
  const mainPath = join(distRoot, 'cli', 'main.js');
  writeFileSync(mainPath, "import { runCli } from './dispatch.js';\n", 'utf8');

  ensureCliShebang(distRoot);
  ensureCliShebang(distRoot);

  const content = readFileSync(mainPath, 'utf8');
  assert.equal(content.startsWith('#!/usr/bin/env node\n'), true);
  assert.equal(content.indexOf('#!/usr/bin/env node', 1), -1);
});

test('ensureCliShebang fails loudly when the CLI entry point is missing', () => {
  const distRoot = mkdtempSync(join(tmpdir(), 'siftkit-shebang-missing-'));

  assert.throws(() => ensureCliShebang(distRoot), /Expected CLI entry point/u);
});
