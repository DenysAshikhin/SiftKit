import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../dist/cli/index.js';
import { parseRuntimeArtifactUri, readRuntimeArtifact } from '../dist/state/runtime-artifacts.js';
import { makeCaptureStream, withTestEnvAndServer } from './_test-helpers.js';

test('siftkit run --shell auto executes a shell script and writes raw log with shell output', async () => {
  await withTestEnvAndServer(async () => {
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
    const rawLogMatch = stdoutText.match(/Raw log: (\S+)/u);
    assert.ok(rawLogMatch, `expected Raw log line, got: ${stdoutText}`);
    const artifactId = parseRuntimeArtifactUri(rawLogMatch[1]);
    assert.ok(artifactId, `expected runtime artifact URI, got: ${rawLogMatch[1]}`);
    const artifact = readRuntimeArtifact(artifactId);
    assert.ok(artifact, 'expected runtime artifact record');
    assert.match(artifact.contentText || '', /kshell-mode-ok/u);
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
