import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { asObject, asObjectArray, requestJson } from './helpers/dashboard-http.js';
import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';

test('DashboardModelQueueHarness validates options before acquiring process resources', () => {
  const previousCwd = process.cwd();
  const previousStatusPort = process.env.SIFTKIT_STATUS_PORT;
  const prefix = `siftkit-http-queue-constructor-failure-${process.pid}-`;
  let cwdAfterFailure = '';
  let statusPortAfterFailure: string | undefined;
  let leftovers: string[] = [];
  try {
    assert.throws(() => new DashboardModelQueueHarness(prefix, {
      get exl3ActivePreset(): boolean {
        throw new Error('forced option failure');
      },
      parallelSlots: 1,
    }), /forced option failure/u);
    cwdAfterFailure = process.cwd();
    statusPortAfterFailure = process.env.SIFTKIT_STATUS_PORT;
    leftovers = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix));
  } finally {
    process.chdir(previousCwd);
    if (previousStatusPort === undefined) {
      delete process.env.SIFTKIT_STATUS_PORT;
    } else {
      process.env.SIFTKIT_STATUS_PORT = previousStatusPort;
    }
    for (const entry of leftovers) {
      fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  }

  assert.equal(cwdAfterFailure, previousCwd);
  assert.equal(statusPortAfterFailure, previousStatusPort);
  assert.deepEqual(leftovers, []);
});

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

test('coordinator-free config update refreshes ParallelSlots admission capacity', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-config-', { parallelSlots: 1 });
  await harness.start();
  try {
    const first = harness.holdModelLock('first request before config update', 400);
    await harness.waitForActiveRequests('repo_search');
    const second = harness.holdModelLock('second queued request', 10);
    await harness.waitForQueuedRequest('repo_search');

    await harness.updateParallelSlots(2);
    assert.equal((await first).statusCode, 200);
    await harness.waitForActiveRequests('repo_search');

    const third = harness.holdModelLock('third request after config update', 10);
    await harness.waitForActiveRequests('repo_search', 2);
    for (const response of await Promise.all([second, third])) {
      assert.equal(response.statusCode, 200);
    }
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});

test('model queue harness closes an active request once without waiting for its work', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-close-', { parallelSlots: 1 });
  await harness.start();
  try {
    const heldRequest = harness.holdModelLock('request active during teardown', 5_000);
    const heldOutcome = heldRequest.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    await harness.waitForActiveRequests('repo_search');

    const firstClose = harness.close();
    const concurrentClose = harness.close();
    const sharedConcurrentPromise = firstClose === concurrentClose;
    const allSettled = Promise.allSettled([firstClose, concurrentClose, heldOutcome]);
    const closedPromptly = await Promise.race([
      allSettled.then(() => true),
      delay(2_500, false, { ref: false }),
    ]);
    if (!closedPromptly) await allSettled;

    const laterClose = harness.close();
    const sharedLaterPromise = laterClose === firstClose;
    await firstClose;
    await concurrentClose;
    await laterClose;

    assert.equal(closedPromptly, true);
    assert.equal(await heldOutcome, 'rejected');
    assert.equal(sharedConcurrentPromise, true);
    assert.equal(sharedLaterPromise, true);
  } finally {
    await harness.close();
  }
});
