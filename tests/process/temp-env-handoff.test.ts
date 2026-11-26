import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { spawnDirectCommand } from '../../src/lib/command-spawn.ts';
import { toStringRecord } from '../../src/lib/captured-command.ts';
import { buildNodeTestArgs } from '../../src/test-runner/test-targets.ts';
import { DEFAULT_TEMP_ENV_HANDOFF_MS, TEST_MANAGED_STARTUP_TIMEOUT_MS, withTempEnv } from '../_runtime-helpers.ts';

const repoRoot = process.cwd();
const FIXTURE = path.join('tests', 'fixtures', 'stuck-temp-env-holder.test.ts');
const HANDOFF_MS = 300;
// Generous over the fixture's ~10 s nested run, but under the 30 s per-test timeout the runner
// applies, so a nested hang is bounded by this budget rather than by the test's own timeout.
const NESTED_RUN_BUDGET_MS = 20_000;

const STUCK = 'handoff fixture: stuck holder';
const SECOND = 'handoff fixture: second test';
const THIRD = 'handoff fixture: third test';
const FOURTH = 'handoff fixture: fourth test';
const ALL_NAMES = [STUCK, SECOND, THIRD, FOURTH];

function nestedChildEnv(overrides: Record<string, string>): Record<string, string> {
  const childEnv = toStringRecord(process.env);
  // node:test refuses to run files when it detects it is already inside a test process.
  delete childEnv.NODE_TEST_CONTEXT;
  return { ...childEnv, ...overrides };
}

function runFixture(handoffOverride: string) {
  return spawnDirectCommand(
    process.execPath,
    ['--test', '--test-timeout=2000', '--test-concurrency=1', FIXTURE],
    {
      cwd: repoRoot,
      timeoutMs: NESTED_RUN_BUDGET_MS,
      env: nestedChildEnv({ SIFTKIT_TEST_TEMP_ENV_HANDOFF_MS: handoffOverride }),
    },
  );
}

// The "✖ failing tests:" block for a test name (its name line plus the indented error/stack), or
// '' when that test did not fail.
function failingBlock(output: string, name: string): string {
  const lines = output.split(/\r?\n/u);
  const failingIndex = lines.findIndex((line) => line.trim() === '✖ failing tests:');
  if (failingIndex < 0) {
    return '';
  }
  const prefix = `✖ ${name} (`;
  for (let i = failingIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith(prefix)) {
      const block = [lines[i]];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '') {
        block.push(lines[j]);
        j += 1;
      }
      return block.join('\n');
    }
  }
  return '';
}

function passed(output: string, name: string): boolean {
  return output.split(/\r?\n/u).some((line) => line.trim().startsWith(`✔ ${name} `));
}

// Regression: the old promise chain guaranteed two concurrent callers could never hold the temp
// environment at once; the handoff must keep that, or the second chdirs out from under the first.
test('overlapping withTempEnv calls take the shared working directory one at a time, in call order', async () => {
  const markers: string[] = [];
  const p1 = withTempEnv(async (tempRoot) => {
    assert.equal(process.cwd(), tempRoot, 'p1 must see its own temp root while it holds the handoff');
    markers.push('p1-enter');
    await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
    markers.push('p1-exit');
  });
  const p2 = withTempEnv(async (tempRoot) => {
    assert.equal(process.cwd(), tempRoot, 'p2 must see its own temp root while it holds the handoff');
    markers.push('p2-enter');
    await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
    markers.push('p2-exit');
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(markers, ['p1-enter', 'p1-exit', 'p2-enter', 'p2-exit']);
});

test('a stuck temp-environment holder fails alone instead of taking the whole file down', {
  timeout: NESTED_RUN_BUDGET_MS * 2,
}, async () => {
  const result = await runFixture(String(HANDOFF_MS));

  assert.notEqual(result.exitCode, 0, `the nested run should fail; output:\n${result.output}`);

  // The stuck holder fails by its own node:test timeout, not by the handoff.
  const stuckBlock = failingBlock(result.output, STUCK);
  assert.ok(stuckBlock.length > 0, 'the stuck holder should have failed');
  assert.doesNotMatch(stuckBlock, /SIFTKIT_TEST_TEMP_ENV_HANDOFF_MS/u);

  // Exactly one further test failed, and it is the handoff: it names what it waited for, the
  // bound, and the temp root the previous test still held.
  const secondBlock = failingBlock(result.output, SECOND);
  assert.ok(secondBlock.length > 0, 'the second test should have failed on the handoff');
  assert.match(secondBlock, /temp environment/u, 'the message should name what it waited for');
  assert.match(secondBlock, /SIFTKIT_TEST_TEMP_ENV_HANDOFF_MS/u, 'the message should name the bound');
  assert.match(secondBlock, new RegExp(`${HANDOFF_MS}ms`, 'u'), 'the message should name the bound value');
  assert.match(secondBlock, /siftkit-node-test-/u, 'the message should name the temp root');

  // The two tests after the handoff passed: they took the released handoff at once.
  for (const name of [THIRD, FOURTH]) {
    assert.equal(failingBlock(result.output, name), '', `${name} should not have failed`);
    assert.ok(passed(result.output, name), `${name} should have passed`);
  }
});

test('an unparseable handoff bound override falls back to the default instead of firing at once', {
  timeout: NESTED_RUN_BUDGET_MS * 2,
}, async () => {
  const result = await runFixture('not-a-number');

  // A 0 bound would fail every waiting test at once with the handoff, while the default bound is
  // far longer than the fixture's 2 s per-test timeout, so no waiting test reaches the handoff.
  for (const name of ALL_NAMES) {
    assert.doesNotMatch(
      failingBlock(result.output, name),
      /SIFTKIT_TEST_TEMP_ENV_HANDOFF_MS/u,
      `${name} must not fail on the handoff`,
    );
  }
});

test('the default handoff bound stays under the runner per-test timeout', () => {
  const timeoutArg = buildNodeTestArgs(process.cwd(), []).find((arg) => arg.startsWith('--test-timeout='));
  if (timeoutArg === undefined) {
    throw new Error('buildNodeTestArgs did not set a per-test timeout');
  }
  const perTestTimeoutMs = Number.parseInt(timeoutArg.split('=')[1] ?? '', 10);
  if (!Number.isFinite(perTestTimeoutMs) || perTestTimeoutMs <= 0) {
    throw new Error(`unexpected per-test timeout: ${timeoutArg}`);
  }
  assert.ok(
    DEFAULT_TEMP_ENV_HANDOFF_MS < perTestTimeoutMs,
    `the default handoff bound (${DEFAULT_TEMP_ENV_HANDOFF_MS}ms) must stay under the per-test timeout (${perTestTimeoutMs}ms)`,
  );
  // A holder that spends its whole bounded startup wait must not lose the shared temp environment
  // to a neighbour that claims it first: the handoff bound has to outlast that wait.
  assert.ok(
    DEFAULT_TEMP_ENV_HANDOFF_MS > TEST_MANAGED_STARTUP_TIMEOUT_MS,
    `the default handoff bound (${DEFAULT_TEMP_ENV_HANDOFF_MS}ms) must outlast a holder that spends its whole bounded startup wait (${TEST_MANAGED_STARTUP_TIMEOUT_MS}ms)`,
  );
});
