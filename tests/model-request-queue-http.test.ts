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

test('an exl3 preset admits concurrent model requests over HTTP', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-exl3-', { exl3ActivePreset: true });
  await harness.start();
  try {
    const first = harness.holdModelLock('first concurrent request', 400);
    await harness.waitForActiveRequest('repo_search');
    const second = harness.holdModelLock('second concurrent request', 400);

    // Both are admitted: no queueing, so the exl3 paged scheduler — not this lock — decides
    // how the two overlap.
    const deadline = Date.now() + 2_000;
    let diagnostics = await readModelRequestDiagnostics(harness.getBaseUrl());
    while (diagnostics.activeCount < 2 && Date.now() < deadline) {
      diagnostics = await readModelRequestDiagnostics(harness.getBaseUrl());
    }
    assert.equal(diagnostics.activeCount, 2);
    assert.deepEqual(diagnostics.activeKinds, ['repo_search', 'repo_search']);
    assert.equal(diagnostics.queueLength, 0);

    for (const response of await Promise.all([first, second])) {
      assert.equal(response.statusCode, 200);
    }
    await harness.waitForModelQueueIdle();
    assert.deepEqual(await readModelRequestDiagnostics(harness.getBaseUrl()), {
      activeCount: 0,
      activeKinds: [],
      queueLength: 0,
    });
  } finally {
    await harness.close();
  }
});

test('a llama preset serializes model requests over HTTP', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-llama-');
  await harness.start();
  try {
    const first = harness.holdModelLock('active request', 400);
    await harness.waitForActiveRequest('repo_search');
    const second = harness.holdModelLock('queued request', 10);
    await harness.waitForQueuedRequest('repo_search');

    const diagnostics = await readModelRequestDiagnostics(harness.getBaseUrl());
    assert.equal(diagnostics.activeCount, 1);
    assert.equal(diagnostics.queueLength, 1);

    for (const response of await Promise.all([first, second])) {
      assert.equal(response.statusCode, 200);
    }
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});
