import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestratorVerificationCheck } from '@siftkit/contracts';
import { findUnrunnableChecks } from '../../src/orchestrator/check-preflight.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

function command(text: string): OrchestratorVerificationCheck {
  return { kind: 'command', command: text, cwd: '.', expectedExitCode: 0 };
}

test('the preflight rejects checks that do not parse or name no command in the check shell, and nothing else', async () => {
  const problems = await findUnrunnableChecks(createManagedTempDir('siftkit-preflight-'), [
    command('node --version'),
    command('node --test 2>&1 | siftkit-missing-tool -E "greets by name"'),
    command('if (Test-Path README.md) { exit 0 } else { exit 1 }'),
    command('exit 0'),
    command('Get-ChildItem | Select-Object -First 1'),
    command('./scripts/check.ps1'),
    command('echo "unterminated'),
    command('node --version'),
    { kind: 'evidence', instruction: 'Read it.', paths: ['README.md'] },
  ], new AbortController().signal);

  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0] ?? '', /^Check `node --test 2>&1 \| siftkit-missing-tool -E "greets by name"` cannot run in PowerShell \(Windows, powershell\.exe\): 'siftkit-missing-tool' is not a PowerShell command or a program on PATH\.$/u);
  assert.match(problems[1] ?? '', /^Check `echo "unterminated` cannot run in .*: does not parse as PowerShell: /u);
});

test('the preflight skips the shell entirely when no check is a command', async () => {
  assert.deepEqual(await findUnrunnableChecks('C:\\does-not-matter', [{ kind: 'evidence', instruction: 'Read it.', paths: ['a'] }],
    new AbortController().signal), []);
});
