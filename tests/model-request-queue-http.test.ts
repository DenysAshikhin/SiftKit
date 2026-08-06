import assert from 'node:assert/strict';
import test from 'node:test';

import { asObject, asObjectArray, requestJson } from './helpers/dashboard-http.js';
import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';

async function readModelRequestDiagnostics(baseUrl: string): Promise<{ activeCount: number; activeKinds: string[]; queueLength: number }> {
  const response = await requestJson(`${baseUrl}/status`);
  const modelRequests = asObject(response.body.modelRequests);
  return {
    activeCount: Number(modelRequests.activeCount),
    activeKinds: asObjectArray(modelRequests.activeRequests).map((entry) => String(entry.kind)),
    queueLength: Number(modelRequests.queueLength),
  };
}

test('ParallelSlots limits exl3 HTTP admission and queues the second request', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-exl3-', { exl3ActivePreset: true, parallelSlots: 1 });
  await harness.start();
  try {
    const first = harness.holdModelLock('active request', 400);
    await harness.waitForActiveRequests('repo_search');
    const second = harness.holdModelLock('queued request', 10);
    await harness.waitForQueuedRequest('repo_search');

    const diagnostics = await readModelRequestDiagnostics(harness.getBaseUrl());
    assert.equal(diagnostics.activeCount, 1);
    assert.deepEqual(diagnostics.activeKinds, ['repo_search']);
    assert.equal(diagnostics.queueLength, 1);

    for (const response of await Promise.all([first, second])) {
      assert.equal(response.statusCode, 200);
    }
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});

test('ParallelSlots allows two llama requests before queueing the third', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-llama-', { parallelSlots: 2 });
  await harness.start();
  try {
    const first = harness.holdModelLock('first request', 400);
    await harness.waitForActiveRequests('repo_search');
    const second = harness.holdModelLock('second request', 400);
    await harness.waitForActiveRequests('repo_search', 2);

    const diagnostics = await readModelRequestDiagnostics(harness.getBaseUrl());
    assert.equal(diagnostics.activeCount, 2);
    assert.deepEqual(diagnostics.activeKinds, ['repo_search', 'repo_search']);
    assert.equal(diagnostics.queueLength, 0);

    for (const response of await Promise.all([first, second])) {
      assert.equal(response.statusCode, 200);
    }
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});

test('ParallelSlots is one global FIFO limit across repo-search and dashboard chat', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-global-', { parallelSlots: 1 });
  await harness.start();
  try {
    const repoSearch = harness.holdModelLock('active repo-search', 400);
    await harness.waitForActiveRequests('repo_search');
    const sessionId = await harness.createChatSession('queued chat', 'model-a');
    const chat = harness.startChatStream(sessionId, 'queued chat prompt');
    await harness.waitForQueuedRequest('dashboard_chat_stream');

    const diagnostics = await readModelRequestDiagnostics(harness.getBaseUrl());
    assert.equal(diagnostics.activeCount, 1);
    assert.deepEqual(diagnostics.activeKinds, ['repo_search']);
    assert.equal(diagnostics.queueLength, 1);

    assert.equal((await repoSearch).statusCode, 200);
    await harness.waitForActiveRequests('dashboard_chat_stream');
    harness.releaseChatResponse('chat completed');
    assert.equal((await chat).events.some((event) => event.event === 'done'), true);
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});
