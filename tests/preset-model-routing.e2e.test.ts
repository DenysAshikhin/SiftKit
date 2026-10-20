import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SiftConfigSchema } from '@siftkit/contracts';

import { requestSse } from './helpers/sse-http.ts';
import { ALTERNATE_MODEL_PRESET_ID, DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.ts';
import { RecordingEngineService } from './helpers/recording-engine-service.ts';
import { requestJson, asObject, requestSse as requestDashboardSse } from './helpers/dashboard-http.ts';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.ts';
import { readChatStream } from './helpers/chat-stream-views.ts';

const MODEL_A = 'exl3-main';

test('a model selected by a chat cannot be deleted until the chat inherits its default', async (t) => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-model-delete-', {
    exl3ActivePreset: true, parallelSlots: 1, alternateModel: true,
  });
  t.after(() => harness.close());
  await harness.start();
  const sessionId = await harness.createChatSession('model owner', 'model-a');
  const sessionUrl = `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}`;
  await requestJson(sessionUrl, { method: 'PUT', body: JSON.stringify({ modelPresetOverrideId: ALTERNATE_MODEL_PRESET_ID }) });
  const configUrl = `${harness.getBaseUrl()}/config?skip_ready=1`;
  const config = SiftConfigSchema.parse((await requestJson(configUrl)).body);
  config.Server.ModelPresets.Presets = config.Server.ModelPresets.Presets.filter(preset => preset.id !== ALTERNATE_MODEL_PRESET_ID);
  const rejected = await requestJson(configUrl, { method: 'PUT', body: JSON.stringify(config) });
  assert.equal(rejected.statusCode, 400, 'deleting a selected model must preserve the chat reference');
  assert.match(String(rejected.body.error), /model owner/u);
  const readable = await requestJson(sessionUrl);
  assert.equal(readable.statusCode, 200);
  await requestJson(sessionUrl, { method: 'PUT', body: JSON.stringify({ modelPresetOverrideId: null }) });
  const removed = await requestJson(configUrl, { method: 'PUT', body: JSON.stringify(config) });
  assert.equal(removed.statusCode, 200);
});

test('web chat model choice persists across modes and overrides their model defaults', async (t) => {
  const engine = new RecordingEngineService();
  const harness = new DashboardModelQueueHarness('siftkit-chat-model-choice-', {
    exl3ActivePreset: true, parallelSlots: 1, alternateModel: true, engineService: engine,
  });
  t.after(() => harness.close());
  await harness.start();
  await harness.assignOperationModel('repo-search', MODEL_A);
  const sessionId = await harness.createChatSession('chosen model', 'model-a');
  const url = `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}`;
  const selected = await requestJson(url, { method: 'PUT', body: JSON.stringify({ modelPresetOverrideId: ALTERNATE_MODEL_PRESET_ID }) });
  assert.equal(selected.statusCode, 200, JSON.stringify(selected.body));
  assert.equal(asObject(selected.body.session).modelPresetOverrideId, ALTERNATE_MODEL_PRESET_ID);
  const changed = await requestJson(url, { method: 'PUT', body: JSON.stringify({ presetId: 'repo-search' }) });
  assert.equal(changed.statusCode, 200, JSON.stringify(changed.body));
  assert.equal(asObject(changed.body.session).modelPresetOverrideId, ALTERNATE_MODEL_PRESET_ID);
  assert.deepEqual(asObject(changed.body.session).defaultModelPreset, { id: MODEL_A, label: 'EXL3 main' });
  const reloaded = await requestJson(url);
  assert.equal(asObject(reloaded.body.session).modelPresetOverrideId, ALTERNATE_MODEL_PRESET_ID);
  harness.releaseChatResponse('chat answer');
  const chat = readChatStream(await harness.startChatStream(sessionId, 'selected-model-chat'), sessionId);
  assert.equal(chat.failure, null);
  assert.equal(chat.terminal?.terminalCause, 'completed');
  harness.releaseChatResponse('search answer');
  const search = await harness.startChatOperationStream('repo-search', sessionId, 'selected-model-search');
  assert.equal(search.statusCode, 200, JSON.stringify(search.events));
  assert.equal(readChatStream(search, sessionId).terminal?.terminalCause, 'completed');
  await harness.assignOperationModel('plan', MODEL_A);
  harness.releaseChatResponse('plan answer');
  const plan = await harness.startChatOperationStream('plan', sessionId, 'selected-model-plan');
  assert.equal(readChatStream(plan, sessionId).terminal?.terminalCause, 'completed');
  await harness.assignOperationModel('repo-agent', MODEL_A);
  const agent = await requestDashboardSse(`${url}/repo-agent/stream`, { method: 'POST', body: JSON.stringify({
    content: 'chosen-model-agent', repoRoot: process.cwd(), approval: 'off',
    operationId: randomUUID(), submissionId: randomUUID(), mockResponses: repoAgentFinishResponses('done'),
  }) });
  assert.equal(agent.statusCode, 200);
  const agentStream = readChatStream(agent, sessionId);
  assert.equal(agentStream.failure, null);
  assert.equal(agentStream.terminal?.terminalCause, 'completed');
  const reset = await requestJson(url, { method: 'PUT', body: JSON.stringify({ modelPresetOverrideId: null }) });
  assert.equal(reset.statusCode, 200, JSON.stringify(reset.body));
  assert.equal(asObject(reset.body.session).modelPresetOverrideId, null);
  harness.releaseChatResponse('default model answer');
  const inherited = await harness.startChatOperationStream('repo-search', sessionId, 'default-model-search');
  assert.equal(readChatStream(inherited, sessionId).terminal?.terminalCause, 'completed');
  const expectedExecutions = [
    { text: 'selected-model-chat', modelPresetId: ALTERNATE_MODEL_PRESET_ID },
    { text: 'selected-model-search', modelPresetId: ALTERNATE_MODEL_PRESET_ID },
    { text: 'selected-model-plan', modelPresetId: ALTERNATE_MODEL_PRESET_ID },
    { text: 'chosen-model-agent', modelPresetId: ALTERNATE_MODEL_PRESET_ID },
    { text: 'default-model-search', modelPresetId: MODEL_A },
  ];
  assert.equal(engine.executions.length, expectedExecutions.length);
  for (const [index, expected] of expectedExecutions.entries()) {
    const actual = engine.executions[index];
    assert.ok(actual);
    assert.ok(actual.text.includes(expected.text), expected.text);
    assert.equal(actual.modelPresetId, expected.modelPresetId, expected.text);
  }
});

test('web chat rejects malformed or missing model choices without changing the session', async (t) => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-model-invalid-', { parallelSlots: 1 });
  t.after(() => harness.close());
  await harness.start();
  const sessionId = await harness.createChatSession('validation', 'model-a');
  const url = `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}`;
  for (const modelPresetOverrideId of ['', 123, 'missing-model']) {
    const response = await requestJson(url, { method: 'PUT', body: JSON.stringify({ modelPresetOverrideId }) });
    assert.equal(response.statusCode, 400, String(modelPresetOverrideId));
  }
  const unchanged = await requestJson(url);
  assert.equal(asObject(unchanged.body.session).modelPresetOverrideId, null);
});

test('chat preference updates validate the whole request before saving any model choice', async (t) => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-update-validation-', { parallelSlots: 1 });
  t.after(() => harness.close());
  await harness.start();
  const sessionId = await harness.createChatSession('unchanged', 'model-a');
  const url = `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}`;
  for (const invalid of [{ thinkingEnabled: 'false' }, { webSearchEnabled: 1 }, { title: 123 }, { presetId: [] }, { planRepoRoot: false }, { unexpected: true }]) {
    const response = await requestJson(url, { method: 'PUT', body: JSON.stringify({ modelPresetOverrideId: null, ...invalid }) });
    assert.equal(response.statusCode, 400, JSON.stringify(invalid));
  }
  assert.equal(asObject((await requestJson(url)).body.session).title, 'unchanged');
});

test('web chat refuses model changes during an active operation', async (t) => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-model-busy-', { parallelSlots: 1 });
  t.after(() => harness.close());
  await harness.start();
  const sessionId = await harness.createChatSession('busy chat', 'model-a');
  const run = harness.startChatStream(sessionId, 'waiting for a response');
  await harness.waitForActiveRequests('dashboard_chat_stream');
  const response = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}`, {
    method: 'PUT', body: JSON.stringify({ modelPresetOverrideId: null }),
  });
  assert.equal(response.statusCode, 409, JSON.stringify(response.body));
  harness.releaseChatResponse('done');
  await run;
});

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
