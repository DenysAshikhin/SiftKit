import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_RUN_ID_ENV, AGENT_SERVER_URL_ENV } from '../../src/lib/agent-run-marker.ts';

/**
 * Fixture for tests/process/run-tests-environment.test.ts, which starts the runner with the nested-run marker set.
 * It lives under tests/fixtures/ because buildNodeTestArgs only collects the top level of tests/.
 */
test('a test process never inherits the nested-run marker', () => {
  assert.deepEqual([process.env[AGENT_RUN_ID_ENV], process.env[AGENT_SERVER_URL_ENV]], [undefined, undefined]);
});
