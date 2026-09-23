import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { asObject, asObjectArray, requestJson, requestSse, type SseResponse } from './helpers/dashboard-http.js';
import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { readChatStream } from './helpers/chat-stream-views.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';

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

test('ParallelSlots allows two inference requests before queueing the third', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-inference-', { parallelSlots: 2 });
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
    assert.equal((await chat).events.some((event) => event.event === 'chat_projection'), true);
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
    const second = harness.holdModelLock('second queued request', 400);
    await harness.waitForQueuedRequest('repo_search');

    // The saved capacity wakes admission: the queued request runs beside the first one.
    await harness.updateParallelSlots(2);
    await harness.waitForActiveRequests('repo_search', 2);
    const third = harness.holdModelLock('third request after config update', 10);
    await harness.waitForQueuedRequest('repo_search');
    for (const response of await Promise.all([first, second, third])) {
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

type HolderTurn = { sessionId: string; stream: Promise<SseResponse> };

/** Holds the only model slot with a Web chat turn until the test releases its engine response. */
async function startHolderTurn(harness: DashboardModelQueueHarness): Promise<HolderTurn> {
  const sessionId = await harness.createChatSession('holder', 'model-a');
  const stream = harness.startChatStream(sessionId, 'holder turn');
  await harness.waitForActiveRequests('dashboard_chat_stream');
  return { sessionId, stream };
}

function assertStreamCompleted(response: SseResponse, sessionId: string): void {
  const { terminal, failure } = readChatStream(response, sessionId);
  assert.equal(failure, null, JSON.stringify(response.events));
  assert.notEqual(terminal, null, JSON.stringify(response.events));
}

/** A Web waiter carries no queue deadline, and it is admitted once the holder releases the slot. */
async function assertQueuedWithoutDeadline(harness: DashboardModelQueueHarness, requestKind: string, holder: HolderTurn): Promise<void> {
  assert.equal((await harness.waitForQueuedRequest(requestKind)).hasDeadline, false);
  harness.releaseChatResponse('holder answer');
  assertStreamCompleted(await holder.stream, holder.sessionId);
}

const WEBUI_STREAM_CASES = [
  { operationKind: 'message', requestKind: 'dashboard_chat_stream' },
  { operationKind: 'plan', requestKind: 'dashboard_plan_stream' },
  { operationKind: 'repo-search', requestKind: 'dashboard_repo_search_stream' },
] as const;

for (const streamCase of WEBUI_STREAM_CASES) {
  test(`webui ${streamCase.operationKind} stream waits in the queue without a deadline and is admitted`, async () => {
    const harness = new DashboardModelQueueHarness(`siftkit-http-queue-unbounded-${streamCase.operationKind}-`, { parallelSlots: 1 });
    await harness.start();
    try {
      const holder = await startHolderTurn(harness);
      const sessionId = await harness.createChatSession(`unbounded ${streamCase.operationKind}`, 'model-a');
      const stream = harness.startChatOperationStream(streamCase.operationKind, sessionId, `wait for the slot ${streamCase.operationKind}`);
      await assertQueuedWithoutDeadline(harness, streamCase.requestKind, holder);
      harness.releaseChatResponse('admitted answer');
      assertStreamCompleted(await stream, sessionId);
      await harness.waitForModelQueueIdle();
    } finally {
      await harness.close();
    }
  });
}

test('webui non-stream message waits in the queue without a deadline and is admitted', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-unbounded-json-', { parallelSlots: 1 });
  await harness.start();
  try {
    const holder = await startHolderTurn(harness);
    const sessionId = await harness.createChatSession('unbounded json', 'model-a');
    harness.registerChatPrompt(sessionId, 'wait for the slot json');
    const turn = requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 30_000,
      body: JSON.stringify({ content: 'wait for the slot json' }),
    });
    await assertQueuedWithoutDeadline(harness, 'dashboard_chat', holder);
    harness.releaseChatResponse('admitted json answer');
    const response = await turn;
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});

test('webui condense waits in the queue without a deadline and is admitted', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-unbounded-condense-', { parallelSlots: 1 });
  await harness.start();
  try {
    const sessionId = await harness.createChatSession('unbounded condense', 'model-a');
    const seeded = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'seed question', assistantContent: 'seed answer' }),
    });
    assert.equal(seeded.statusCode, 200, JSON.stringify(seeded.body));
    const holder = await startHolderTurn(harness);
    const condense = requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/condense`, {
      method: 'POST',
      timeoutMs: 30_000,
      body: JSON.stringify({ mockResponses: [{ content: 'condensed summary' }] }),
    });
    await assertQueuedWithoutDeadline(harness, 'dashboard_chat_condense', holder);
    const response = await condense;
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});

test('webui repo-agent run waits in the queue without a deadline and is admitted', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-unbounded-repo-agent-', { parallelSlots: 1 });
  await harness.start();
  try {
    const holder = await startHolderTurn(harness);
    const sessionId = await harness.createChatSession('unbounded repo-agent', 'model-a');
    const stream = requestSse(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
      method: 'POST',
      timeoutMs: 30_000,
      body: JSON.stringify({
        content: 'wait for the slot repo-agent',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: randomUUID(),
        submissionId: randomUUID(),
        mockResponses: repoAgentFinishResponses('repo-agent admitted'),
        mockCommandResults: {},
      }),
    });
    await assertQueuedWithoutDeadline(harness, 'repo_search', holder);
    assertStreamCompleted(await stream, sessionId);
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});
