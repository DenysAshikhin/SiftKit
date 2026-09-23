import test from 'node:test';
import assert from 'node:assert/strict';

import { requestSse } from './helpers/sse-http.js';
import { ALTERNATE_MODEL_PRESET_ID, DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { RecordingEngineService } from './helpers/recording-engine-service.js';

const MODEL_A = 'exl3-main';

test('resident work runs first, a switch happens once, and an existing chat follows the resident model', async (t) => {
  const engine = new RecordingEngineService();
  const harness = new DashboardModelQueueHarness('siftkit-preset-model-routing-', {
    exl3ActivePreset: true,
    parallelSlots: 1,
    alternateModel: true,
    engineService: engine,
  });
  t.after(() => harness.close());
  await harness.start();
  const chatSessionId = await harness.createChatSession('created on a', 'model-a');

  const activeA = harness.holdModelLock('active-a', 600);
  await harness.waitForActiveRequests('repo_search');
  await harness.assignOperationModel('repo-search', ALTERNATE_MODEL_PRESET_ID);
  await harness.assignOperationModel('summary', MODEL_A);
  const searchB = requestSse(`${harness.getBaseUrl()}/repo-search`, {
    body: { prompt: 'search-b', repoRoot: process.cwd(), maxTurns: 1, mockResponses: [{ content: 'done' }] },
  });
  await harness.waitForQueuedRequest('repo_search');
  const summaryA = requestSse(`${harness.getBaseUrl()}/summary`, {
    body: { question: 'summary-a', inputText: 'input for summary-a', repoRoot: process.cwd(), provider: 'mock' },
  });
  await harness.waitForQueuedRequest('summary');

  assert.equal((await activeA).statusCode, 200);
  for (const response of await Promise.all([searchB, summaryA])) {
    assert.equal(response.errorMessage, null, response.rawBody);
  }
  harness.releaseChatResponse('existing chat answer');
  const chat = await harness.startChatStream(chatSessionId, 'existing-chat');
  assert.equal(chat.statusCode, 200, JSON.stringify(chat.events));
  await harness.waitForModelQueueIdle();

  assert.deepEqual(engine.executions.map((execution) => execution.text), ['active-a', 'summary-a', 'search-b', 'existing-chat']);
  assert.deepEqual(engine.executions.map((execution) => execution.modelPresetId),
    [MODEL_A, MODEL_A, ALTERNATE_MODEL_PRESET_ID, ALTERNATE_MODEL_PRESET_ID]);
  assert.deepEqual(harness.loadedModelNames, ['model-a', 'model-b'], 'B loads once and A is never reloaded for the chat');
});

test('alternating assigned operations switch models in request order and never run on the wrong one', async (t) => {
  const engine = new RecordingEngineService();
  const harness = new DashboardModelQueueHarness('siftkit-preset-model-alternation-', {
    exl3ActivePreset: true,
    parallelSlots: 1,
    alternateModel: true,
    engineService: engine,
  });
  t.after(() => harness.close());
  await harness.start();
  await harness.assignOperationModel('repo-search', ALTERNATE_MODEL_PRESET_ID);
  await harness.assignOperationModel('summary', MODEL_A);

  for (const step of ['search-1', 'summary-1', 'search-2']) {
    const response = step.startsWith('search')
      ? await requestSse(`${harness.getBaseUrl()}/repo-search`, {
        body: { prompt: step, repoRoot: process.cwd(), maxTurns: 1, mockResponses: [{ content: 'done' }] },
      })
      : await requestSse(`${harness.getBaseUrl()}/summary`, {
        body: { question: step, inputText: `input for ${step}`, repoRoot: process.cwd(), provider: 'mock' },
      });
    assert.equal(response.errorMessage, null, response.rawBody);
  }

  assert.deepEqual(engine.executions.map((execution) => execution.modelPresetId),
    [ALTERNATE_MODEL_PRESET_ID, MODEL_A, ALTERNATE_MODEL_PRESET_ID]);
  assert.deepEqual(harness.loadedModelNames, ['model-a', 'model-b', 'model-a', 'model-b']);
});
