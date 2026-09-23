import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli } from '../../src/cli/index.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import { makeCaptureStream, withTestEnvAndServer } from '../_test-helpers.js';
import { asObject } from '../helpers/dashboard-http.js';

test('internal op command via request file runs command', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req-cmd.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("hello")'],
      Question: 'What was printed?',
      NoSummarize: true,
    }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'command', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = asObject(parseJsonValueText(stdout.read().trim()));
    assert.equal(parsed.ExitCode, 0);
  });
});
