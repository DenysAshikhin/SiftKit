import assert from 'node:assert/strict';
import test from 'node:test';

import { runVerificationCheck } from '../../src/orchestrator/verification.ts';
import { digestOutput } from '../../src/output-digest/digest.ts';
import { digestFixturePath, readDigestFixture } from '../helpers/output-digest-fixtures.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

async function runCommandCheck(command: string) {
  return runVerificationCheck({
    repoRoot: createManagedTempDir('siftkit-check-digest-'),
    check: { kind: 'command', command, cwd: '.', expectedExitCode: 0 },
    abortSignal: new AbortController().signal,
  });
}

test('a check is digested from its whole output before the stored output is cut to its last 20,000 characters', async () => {
  const result = await runCommandCheck(`Get-Content -Raw -Encoding UTF8 '${digestFixturePath('pytest/fail.txt')}'; `
    + '1..2000 | ForEach-Object { "noise line $_ of the check log" }; exit 1');
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.length <= 20_000);
  assert.doesNotMatch(result.output, /short test summary info/u, 'the stored tail no longer holds the failures');
  assert.equal(result.digest, digestOutput(readDigestFixture('pytest/fail.txt'))?.text);
});

test('a stored digest of thousands of failures is cut to 20,000 characters from its end', async () => {
  const result = await runCommandCheck('1..3000 | ForEach-Object { "FAILED tests/test_x.py::test_$_ - assert 0" }; '
    + "'===== 3000 failed in 1.00s ====='; exit 1");
  const digest = result.digest ?? '';
  assert.ok(digest.length <= 20_000, String(digest.length));
  assert.ok(digest.startsWith('Digest of the whole output:\npytest: FAILED (3000 failed)\n✖ tests/test_x.py::test_1\n'), digest.slice(0, 200));
  assert.match(digest, /\n… \d+ more digest lines$/u);
});
