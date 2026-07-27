import test from 'node:test';
import assert from 'node:assert/strict';

import { requestSse } from './helpers/sse-http.js';
import { startHarness, waitForActiveModelRequestOwner } from './helpers/streamed-op-harness.js';
import { AGENT_RUN_ID_HEADER } from '../src/lib/agent-run-marker.js';

const AGENT_LOCK_HOLD_MS = 5_000;
const SSE_REQUEST_TIMEOUT_MS = 30_000;

const ANALYZE_BODY = {
  outputKind: 'command',
  exitCode: 0,
  combinedText: 'all tests passed',
  question: 'did it pass?',
  backend: 'mock',
};

test('summary-family request whose marker matches the active agent run is rejected, others queue', async () => {
  const harness = await startHarness('siftkit-selfcall-reject-');
  try {
    const agentRun = requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'hold the lock',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 2,
      approval: 'off',
        availableModels: ['mock-model'],
        simulateWorkMs: AGENT_LOCK_HOLD_MS,
        mockResponses: ['{\"action\":\"finish\",\"output\":\"done\"}'],
        mockCommandResults: {},
      },
      timeoutMs: SSE_REQUEST_TIMEOUT_MS,
    });

    const ownerRunId = await waitForActiveModelRequestOwner(harness.baseUrl);

    const rejected = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: ANALYZE_BODY,
      headers: { [AGENT_RUN_ID_HEADER]: ownerRunId },
    });
    assert.equal(rejected.statusCode, 409, rejected.rawBody);
    assert.match(rejected.rawBody, /self-call/);

    const queued = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: ANALYZE_BODY,
      headers: { [AGENT_RUN_ID_HEADER]: 'some-finished-run' },
      timeoutMs: SSE_REQUEST_TIMEOUT_MS,
    });
    assert.equal(queued.statusCode, 200);
    assert.ok(queued.result, queued.rawBody);

    const agentResponse = await agentRun;
    assert.ok(agentResponse.result, agentResponse.rawBody);
  } finally {
    await harness.close();
  }
});
