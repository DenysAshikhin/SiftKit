import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildNodeTestArgs } from '../../src/test-runner/test-targets.js';

test('buildNodeTestArgs ignores a compiled wrapper that is absent from the validated manifest', () => {
  const unlistedTarget = path.join('.test-build', 'tests', 'unlisted-generated.test.js');
  fs.writeFileSync(unlistedTarget, "throw new Error('must not run');\n", 'utf8');
  let args: string[] = [];
  try {
    args = buildNodeTestArgs(process.cwd(), []);
  } finally {
    fs.rmSync(unlistedTarget, { force: true });
  }

  assert.equal(args.includes(unlistedTarget), false);
});
