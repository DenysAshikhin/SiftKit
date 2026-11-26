import test from 'node:test';
import assert from 'node:assert/strict';

import { withTempEnv } from '../_runtime-helpers.ts';

/**
 * Fixture for tests/process/temp-env-handoff.test.ts: the first test acquires the shared temp
 * environment and then never settles, holding the handoff for every test after it.
 *
 * It lives under tests/fixtures/ because buildNodeTestArgs only collects the top level of tests/
 * (tests/test-targets.test.ts asserts that exclusion), which keeps it out of the real suite.
 */
test('handoff fixture: stuck holder', async () => {
  await withTempEnv(async () => {
    await new Promise<void>(() => {});
  });
});

test('handoff fixture: second test', async () => {
  await withTempEnv(async () => {
    assert.equal(1 + 1, 2);
  });
});

test('handoff fixture: third test', async () => {
  await withTempEnv(async () => {
    assert.ok(true);
  });
});

test('handoff fixture: fourth test', async () => {
  await withTempEnv(async () => {
    assert.ok(true);
  });
});
