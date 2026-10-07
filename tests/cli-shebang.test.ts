import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('the CLI source carries a node shebang, because npm\'s sh shim executes it directly', () => {
  assert.equal(fs.readFileSync(path.resolve('src', 'cli', 'main.ts'), 'utf8').startsWith('#!/usr/bin/env node\n'), true);
});
