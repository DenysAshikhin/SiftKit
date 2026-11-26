import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { CommandOutputAnalyzer } from '../../src/command-output/analyzer.ts';
import { invokeProcess, invokeShellProcess, captureWithTranscript } from '../../src/capture/process.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.ts';
import { withTestEnvAndServer } from '../_test-helpers.ts';

test('runCommand invokes a real command and produces a result', async () => {
  await withTestEnvAndServer(async () => {
    const processResult = invokeProcess('node', ['-e', 'console.log("hello from test")']);
    const result = await new CommandOutputAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: processResult.ExitCode,
      combinedText: processResult.Combined,
      commandText: 'node -e console.log("hello from test")',
      question: 'What was printed?',
      noSummarize: true,
    });
    assert.equal(result.ExitCode, 0);
    assert.equal(result.WasSummarized, false);
    assert.equal(typeof result.RawLogPath, 'string');
  });
});

test('runCommand handles nonexistent command gracefully', async () => {
  await withTestEnvAndServer(async () => {
    const processResult = invokeProcess('definitely_not_a_real_command_xyz123');
    const result = await new CommandOutputAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: processResult.ExitCode,
      combinedText: processResult.Combined,
      commandText: 'definitely_not_a_real_command_xyz123',
      question: 'Did it work?',
      noSummarize: true,
    });
    assert.ok(result.ExitCode !== 0 || typeof result.Summary === 'string');
  });
});

test('runCommand with Shell mode runs a script through the platform shell', async () => {
  await withTestEnvAndServer(async () => {
    const script = process.platform === 'win32'
      ? '$x = ""; if ($x) { Write-Output "non-empty" } else { Write-Output "shell-mode-clean" }'
      : 'x=""; if [ -z "$x" ]; then echo shell-mode-clean; else echo non-empty; fi';
    const processResult = invokeShellProcess(script, 'auto');
    const result = await new CommandOutputAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: processResult.ExitCode,
      combinedText: processResult.Combined,
      commandText: `[auto] ${script}`,
      question: 'What was printed?',
      noSummarize: true,
      shell: 'auto',
    });
    assert.equal(result.ExitCode, 0);
    assert.equal(result.WasSummarized, false);
    assert.equal(typeof result.RawLogPath, 'string');
  });
});

// Deny RX for Everyone so a plain spawn of the file fails with EPERM, then prove the capture
// path reports that spawn error instead of re-running the argv through a shell.
function withDeniedFile(directory: string, callback: (filePath: string) => void): void {
  const filePath = path.join(directory, 'denied.txt');
  fs.writeFileSync(filePath, 'denied');
  const denied = invokeProcess('icacls', [filePath, '/deny', '*S-1-1-0:(RX)']);
  assert.equal(denied.ExitCode, 0);
  assert.match(spawnSync(filePath, [], { encoding: 'utf8', shell: false, windowsHide: true, cwd: process.cwd() }).error?.message ?? '', /EPERM|EACCES/u);
  try {
    callback(filePath);
  } finally {
    invokeProcess('icacls', [filePath, '/reset']);
  }
}

test('both capture paths surface a permission error without re-running through a shell', { skip: process.platform !== 'win32' }, async () => {
  const directory = createManagedTempDir('siftkit-capture-no-shell-');
  try {
    withDeniedFile(directory, (filePath) => {
      const result = invokeProcess(filePath);
      assert.equal(result.ExitCode, 1);
      assert.match(result.StdErr, /spawn/u);
      assert.match(result.StdErr, /EPERM/u);
      assert.ok(!result.Combined.includes('is not recognized as an internal or external command'));
      const transcript = captureWithTranscript(filePath, []);
      assert.equal(transcript.ExitCode, 1);
      assert.match(transcript.Transcript, /spawn/u);
      assert.match(transcript.Transcript, /EPERM/u);
      assert.ok(!transcript.Transcript.includes('is not recognized as an internal or external command'));
    });
  } finally {
    assert.equal(await removeDirectoryWithRetries(directory), true);
  }
});
