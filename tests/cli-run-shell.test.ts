import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../dist/cli/index.js';
import { makeCaptureStream, withTestEnvAndServer } from './_test-helpers.js';

test('siftkit run --shell auto executes a shell script and sends output to the server', async () => {
  await withTestEnvAndServer(async ({ stub }) => {
    const script = process.platform === 'win32'
      ? '$marker = "ksh"; $marker += "ell-mode-ok"; Write-Output $marker'
      : 'a=ksh; b=ell-mode-ok; printf "%s%s\\n" "$a" "$b"';
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['run', '--shell', 'auto', '--command', script, '--question', 'What was printed?'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0, stderr.read() || stdout.read());
    const stdoutText = stdout.read();
    assert.match(stdoutText, /mock command output analysis/u);
    assert.match(stdoutText, /Raw log: db:\/\/command-output\/raw/u);

    const commandRequest = stub.state.chatRequests.find((request) => request.outputKind === 'command');
    assert.ok(commandRequest);
    assert.equal(commandRequest.shell, 'auto');
    assert.match(String(commandRequest.commandText), /^\[auto\] /u);
    assert.match(String(commandRequest.combinedText), /kshell-mode-ok/u);
  });
});

test('siftkit run --shell rejects unknown shell name with a clear error', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['run', '--shell', 'fish', '--command', 'echo x', '--question', 'q'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /unsupported shell/iu);
  });
});
