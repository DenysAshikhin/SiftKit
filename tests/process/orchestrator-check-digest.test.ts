import assert from 'node:assert/strict';
import test from 'node:test';

import { runVerificationCheck } from '../../src/orchestrator/verification.ts';
import { digestToolOutput, renderDigests } from '../../src/output-digest/digest.ts';
import { digestFixturePath, readDigestFixture } from '../helpers/output-digest-fixtures.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

test('a check is digested from its whole output before the stored output is cut to its last 20,000 characters', async () => {
  const command = `Get-Content -Raw -Encoding UTF8 '${digestFixturePath('pytest/fail.txt')}'; `
    + '1..2000 | ForEach-Object { "noise line $_ of the check log" }; exit 1';
  const result = await runVerificationCheck({
    repoRoot: createManagedTempDir('siftkit-check-digest-'),
    check: { kind: 'command', command, cwd: '.', expectedExitCode: 0 },
    abortSignal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.length <= 20_000);
  assert.doesNotMatch(result.output, /short test summary info/u, 'the stored tail no longer holds the failures');
  assert.equal(result.digest, renderDigests(digestToolOutput(readDigestFixture('pytest/fail.txt'))));
});
