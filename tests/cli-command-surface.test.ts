import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.js';
import { KNOWN_COMMANDS, SERVER_DEPENDENT_COMMANDS } from '../src/cli/args.js';
import { makeCaptureStream } from './_test-helpers.js';

test('blocked public commands are not accessible', async () => {
  const blocked = ['install', 'test', 'eval', 'config-get', 'config-set'];
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

test('global backend command is absent from the public command surface', () => {
  assert.equal(KNOWN_COMMANDS.has('backend'), false);
  assert.equal(SERVER_DEPENDENT_COMMANDS.has('backend'), false);
});
