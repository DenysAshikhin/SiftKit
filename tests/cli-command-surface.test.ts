import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../dist/cli/index.js';
import { makeCaptureStream } from './_test-helpers.js';

test('blocked public commands are not accessible', async () => {
  const blocked = ['run', 'install', 'test', 'eval', 'config-get', 'config-set'];
  for (const command of blocked) {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: [command],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /not exposed in this CLI build/u);
  }
});
