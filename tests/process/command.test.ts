import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandOutputAnalyzer } from '../../src/command-output/analyzer.js';
import { invokeProcess, invokeShellProcess } from '../../src/capture/process.js';
import { withTestEnvAndServer } from '../_test-helpers.js';

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
