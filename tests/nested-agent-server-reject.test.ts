import test from 'node:test';
import assert from 'node:assert/strict';

import { requestSse } from './helpers/sse-http.js';
import { asObject, requestJson } from './helpers/dashboard-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { AGENT_RUN_ID_HEADER } from '../src/lib/agent-run-marker.js';

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
        approval: false,
        availableModels: ['mock-model'],
        simulateWorkMs: 5000,
        mockResponses: ['{\"action\":\"finish\",\"output\":\"done\"}'],
        mockCommandResults: {},
      },
      timeoutMs: 30_000,
    });

    let ownerRunId = '';
    for (let attempt = 0; attempt < 200 && !ownerRunId; attempt += 1) {
      const status = await requestJson(`${harness.baseUrl}/status`);
      const activeRequest = asObject(asObject(status.body.modelRequests).activeRequest);
      ownerRunId = String(activeRequest.ownerRunId || '');
      if (!ownerRunId) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ownerRunId, 'expected the agent run to hold the lock with an ownerRunId');

    const rejected = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: ANALYZE_BODY,
      headers: { [AGENT_RUN_ID_HEADER]: ownerRunId },
    });
    assert.equal(rejected.statusCode, 409, rejected.rawBody);
    assert.match(rejected.rawBody, /self-call/);

    const queued = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: ANALYZE_BODY,
      headers: { [AGENT_RUN_ID_HEADER]: 'some-finished-run' },
      timeoutMs: 30_000,
    });
    assert.equal(queued.statusCode, 200);
    assert.ok(queued.result, queued.rawBody);

    const agentResponse = await agentRun;
    assert.ok(agentResponse.result, agentResponse.rawBody);
  } finally {
    await harness.close();
  }
});
