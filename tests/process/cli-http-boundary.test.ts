import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../../src/cli/index.js';
import { makeCaptureStream } from '../_test-helpers.js';
import { withBoundaryServer } from '../helpers/cli-boundary-server.js';

test('run command executes locally and sends captured output to server', async () => {
  await withBoundaryServer(async (server) => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: [
        'run',
        '--command',
        'node',
        '--arg',
        '-e',
        '--arg',
        'process.stdout.write("client-ran-command")',
        '--question',
        'What happened?',
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.match(stdout.read(), /server command analysis/u);
    assert.equal(stderr.read(), '');
    const commandRequest = server.requests.find((request) => request.route === '/command-output/analyze');
    assert.ok(commandRequest);
    assert.equal(commandRequest.body.combinedText, 'client-ran-command');
    assert.equal(commandRequest.body.exitCode, 0);
    assert.equal(commandRequest.body.repoRoot, process.cwd());
    assert.match(String(commandRequest.body.commandText), /^node -e/u);
  });
});
