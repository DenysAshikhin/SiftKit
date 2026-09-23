import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { getActiveModelPreset } from '../src/config/getters.js';
import type { SiftConfig } from '../src/config/types.js';
import { requestSse } from './helpers/sse-http.js';
import { asObject, requestJson } from './helpers/dashboard-http.js';
import { ALTERNATE_MODEL_PRESET_ID, DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { RecordingEngineService } from './helpers/recording-engine-service.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';

async function startRoutingHarness(t: TestContext, prefix: string): Promise<{
  harness: DashboardModelQueueHarness;
  engine: RecordingEngineService;
}> {
  const engine = new RecordingEngineService();
  const harness = new DashboardModelQueueHarness(prefix, {
    exl3ActivePreset: true,
    parallelSlots: 1,
    alternateModel: true,
    engineService: engine,
  });
  t.after(() => harness.close());
  await harness.start();
  return { harness, engine };
}

function requireConfig(config: SiftConfig | undefined): SiftConfig {
  assert.ok(config, 'expected the route to hand the engine its admitted config');
  return config;
}

function summaryBody(question: string, extra: Record<string, string> = {}) {
  return { question, inputText: `input for ${question}`, repoRoot: process.cwd(), provider: 'mock', ...extra };
}

function repoSearchBody(prompt: string) {
  return {
    prompt,
    repoRoot: process.cwd(),
    maxTurns: 1,
    mockResponses: [{ content: 'done' }],
  };
}

test('a summary preset assigned to another model loads it and executes on it', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-summary-');
  await harness.assignOperationModel('summary', ALTERNATE_MODEL_PRESET_ID);
  assert.deepEqual(harness.loadedModelNames, ['model-a'], 'saving an assignment must not load a model');

  const response = await requestSse(`${harness.getBaseUrl()}/summary`, { body: summaryBody('explicit-b') });

  assert.equal(response.errorMessage, null, response.rawBody);
  const config = requireConfig(engine.requireSummary('explicit-b').config);
  assert.equal(getActiveModelPreset(config).id, ALTERNATE_MODEL_PRESET_ID);
  assert.equal(getActiveModelPreset(config).Model, 'model-b');
  assert.deepEqual(harness.loadedModelNames, ['model-a', 'model-b']);
});

test('an inheriting operation runs on the model a previous operation switched to', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-inherit-');
  await harness.assignOperationModel('repo-search', ALTERNATE_MODEL_PRESET_ID);

  const search = await requestSse(`${harness.getBaseUrl()}/repo-search`, { body: repoSearchBody('search on b') });
  assert.equal(search.errorMessage, null, search.rawBody);
  const searchRequest = engine.requireRepoSearch('search on b');
  assert.equal(getActiveModelPreset(requireConfig(searchRequest.config)).id, ALTERNATE_MODEL_PRESET_ID);

  const summary = await requestSse(`${harness.getBaseUrl()}/summary`, { body: summaryBody('inherits-b') });
  assert.equal(summary.errorMessage, null, summary.rawBody);
  assert.equal(getActiveModelPreset(requireConfig(engine.requireSummary('inherits-b').config)).id, ALTERNATE_MODEL_PRESET_ID);
  assert.deepEqual(harness.loadedModelNames, ['model-a', 'model-b'], 'the inherited operation must not reload A');
});

test('a CLI model argument selects the matching configured profile', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-override-');

  const response = await requestSse(`${harness.getBaseUrl()}/summary`, { body: summaryBody('override-b', { model: 'model-b' }) });

  assert.equal(response.errorMessage, null, response.rawBody);
  const config = requireConfig(engine.requireSummary('override-b').config);
  assert.equal(getActiveModelPreset(config).id, ALTERNATE_MODEL_PRESET_ID);
});

test('an unknown CLI model argument is a request error that runs nothing', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-unknown-');

  const response = await requestJson(`${harness.getBaseUrl()}/summary`, {
    method: 'POST',
    body: JSON.stringify(summaryBody('unknown-model', { model: 'not-configured' })),
  });

  assert.equal(response.statusCode, 400);
  assert.match(String(response.body.error), /not-configured/u);
  assert.equal(engine.summaryRequests.length, 0);
  assert.deepEqual(harness.loadedModelNames, ['model-a']);
});

test('the preset runner executes a routed operation preset on its model', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-preset-');
  await harness.assignOperationModel('repo-search', ALTERNATE_MODEL_PRESET_ID);

  const response = await requestSse(`${harness.getBaseUrl()}/preset/run`, {
    body: { presetId: 'repo-search', prompt: 'preset run on b', repoRoot: process.cwd(), maxTurns: 1 },
  });

  assert.ok(engine.repoSearchRequests.length > 0, response.rawBody);
  const request = engine.requireRepoSearch('preset run on b');
  assert.equal(getActiveModelPreset(requireConfig(request.config)).id, ALTERNATE_MODEL_PRESET_ID);
});

test('an existing chat session runs its next operation on the model its preset now resolves to', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-chat-');
  const sessionId = await harness.createChatSession('created on a', 'model-a');
  await harness.assignOperationModel('chat', ALTERNATE_MODEL_PRESET_ID);
  harness.releaseChatResponse('answer on b');

  const response = await harness.startChatStream(sessionId, 'chat turn on b');

  assert.equal(response.statusCode, 200, JSON.stringify(response.events));
  assert.equal(getActiveModelPreset(requireConfig(engine.requireRepoSearch('chat turn on b').config)).id, ALTERNATE_MODEL_PRESET_ID);
  assert.deepEqual(harness.loadedModelNames, ['model-a', 'model-b']);
  const session = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(asObject(session.body.session).modelPresetId, ALTERNATE_MODEL_PRESET_ID, 'the session records the model its run was admitted on');
});

test('a repo-agent run executes on the model its preset is assigned to', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-agent-');
  await harness.assignOperationModel('repo-agent', ALTERNATE_MODEL_PRESET_ID);

  const response = await requestSse(`${harness.getBaseUrl()}/repo-agent`, {
    body: { prompt: 'agent run on b', repoRoot: process.cwd(), maxTurns: 1, approval: 'off', mockResponses: repoAgentFinishResponses('done') },
  });

  assert.equal(response.errorMessage, null, response.rawBody);
  assert.equal(getActiveModelPreset(requireConfig(engine.requireRepoSearch('agent run on b').config)).id, ALTERNATE_MODEL_PRESET_ID);
  assert.deepEqual(harness.loadedModelNames, ['model-a', 'model-b']);
});

test('chat images are checked against the model the operation will run on', async (t) => {
  const { harness, engine } = await startRoutingHarness(t, 'siftkit-routing-image-');
  const sessionId = await harness.createChatSession('image routing', 'model-a');
  await harness.assignOperationModel('chat', ALTERNATE_MODEL_PRESET_ID);

  const response = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'describe this', images: [toDataUrl('image/png', rasterBuffer('png', 1, 1))] }),
  });

  assert.equal(response.statusCode, 400, JSON.stringify(response.body));
  assert.match(String(response.body.error), /vision/iu);
  assert.equal(engine.repoSearchRequests.length, 0);
  assert.deepEqual(harness.loadedModelNames, ['model-a'], 'a refused submission must not load B');
});
