import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageMetadataSchema } from '@siftkit/contracts';

import {
  ChatMessageImageNotFoundError,
  deleteChatMessage,
  deleteChatMessageImage,
  updateChatMessageImageCaption,
  readChatSessionFromPath,
  saveChatSession,
  getChatSessionPath,
} from '../src/state/chat-sessions.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { startStatusServer } from '../src/status-server/index.js';
import { getAddressInfo, requestJson, asObject } from './helpers/dashboard-http.js';
import { configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo } from './helpers/dashboard-test-repo.js';
import path from 'node:path';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { getConfigPath } from '../src/config/index.js';
import { getActiveModelPreset } from '../src/config/getters.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { ScorecardSchema } from '../src/repo-search/engine.js';

function imageMetadata(width = 1, height = 1, caption: string | null = null) {
  return ImageMetadataSchema.parse({
    width,
    height,
    originalWidth: width,
    originalHeight: height,
    mime: 'image/png',
    byteLength: 1,
    tokenEstimate: 1,
    resized: false,
    caption,
  });
}

function seedCaptionSession(options: {
  visionEnabled?: boolean;
  visionImageRetention?: number;
  snapshotPreset?: boolean;
  withMetadata?: boolean;
} = {}) {
  const runtimeRoot = path.dirname(getConfigPath());
  const config = getDefaultConfig();
  const configuredPreset = getActiveModelPreset(config);
  configuredPreset.Backend = 'exl3';
  configuredPreset.VisionEnabled = options.visionEnabled ?? true;
  configuredPreset.VisionImageRetention = options.visionImageRetention ?? 8;
  const snapshotPreset = {
    ...configuredPreset,
    id: 'caption-snapshot',
    VisionEnabled: true,
    VisionImageRetention: 8,
  };
  const globalPreset = {
    ...configuredPreset,
    id: 'caption-global',
    VisionEnabled: false,
    VisionImageRetention: 8,
  };
  if (options.snapshotPreset) {
    config.Server.ModelPresets.Presets = [globalPreset, snapshotPreset];
    config.Server.ModelPresets.ActivePresetId = globalPreset.id;
  }
  writeConfig(getConfigPath(), config);
  const session = createTestChatSession(runtimeRoot);
  if (options.snapshotPreset) {
    session.modelPresetId = snapshotPreset.id;
    session.modelPreset = snapshotPreset;
  } else {
    session.modelPresetId = configuredPreset.id;
    session.modelPreset = configuredPreset;
  }
  const image = toDataUrl('image/png', rasterBuffer('png', 1, 1));
  const message = {
    id: 'caption-message',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'describe this',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: [image],
    ...(options.withMetadata === false ? {} : {
      imageMeta: [imageMetadata()],
    }),
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });
  return { runtimeRoot, session, message };
}

async function closeCaptionTestServer(
  server: ReturnType<typeof startStatusServer>,
  previousCwd: string,
  envBackup: ReturnType<typeof configureDashboardTestEnv>,
  tempRoot: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restoreDashboardTestRepo(previousCwd);
  await removeDirectoryWithRetries(tempRoot);
}

async function withCaptionServer(
  options: Parameters<typeof seedCaptionSession>[0] = {},
): Promise<{
  tempRoot: string;
  previousCwd: string;
  envBackup: ReturnType<typeof configureDashboardTestEnv>;
  fixture: ReturnType<typeof seedCaptionSession>;
  server: ReturnType<typeof startStatusServer>;
  baseUrl: string;
}> {
  const tempRoot = createManagedTempDir('siftkit-caption-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const fixture = seedCaptionSession(options);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  return { tempRoot, previousCwd, envBackup, fixture, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function mockedCaptionExecution(finalOutput: string, compactionSummary = ''): RepoSearchExecutionResult {
  const scorecard = ScorecardSchema.parse({
    runId: 'caption-test',
    model: 'caption-model',
    tasks: [{
      id: 'caption',
      question: 'caption',
      reason: 'mock',
      turnsUsed: 1,
      safetyRejects: 0,
      invalidResponses: 0,
      commandFailures: 0,
      finishChallenges: 0,
      mutatedPaths: [],
      commands: [],
      turnThinking: {},
      finalOutput,
      compactionSummary,
      passed: true,
      missingSignals: [],
      promptTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      thinkingTokens: 0,
      outputTokensEstimatedCount: 0,
      thinkingTokensEstimatedCount: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      promptEvalDurationMs: 0,
      generationDurationMs: 0,
      speculativeAcceptedTokens: 0,
      speculativeGeneratedTokens: 0,
      toolStats: {},
      readOverlapSummary: {
        byFile: [],
        totalLinesRead: 0,
        totalUniqueLinesRead: 0,
        totalOverlapLines: 0,
        overlapRatePct: 0,
      },
    }],
    totals: {},
    toolStats: {},
    readOverlapSummary: {
      byFile: [],
      totalLinesRead: 0,
      totalUniqueLinesRead: 0,
      totalOverlapLines: 0,
      overlapRatePct: 0,
    },
    verdict: 'pass',
    failureReasons: [],
  });
  return { requestId: 'caption-test', transcriptPath: '', artifactPath: '', scorecard };
}

test('updates only the requested persisted image caption', () => {
  const runtimeRoot = createManagedTempDir('siftkit-caption-db-');
  const session = createTestChatSession(runtimeRoot);
  const firstMessage = {
    id: 'message-1',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'two images',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='],
    imageMeta: [
      imageMetadata(),
      imageMetadata(2, 2, 'keep me'),
    ],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [firstMessage] });

  updateChatMessageImageCaption(runtimeRoot, session.id, firstMessage.id, 0, 'new caption');

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
  assert.deepEqual(reloaded?.messages?.[0]?.images, firstMessage.images);
  assert.equal(reloaded?.messages?.[0]?.imageMeta?.[0]?.caption, 'new caption');
  assert.equal(reloaded?.messages?.[0]?.imageMeta?.[1]?.caption, 'keep me');
});

test('caption persistence helper rejects missing targets and invalid boundaries', () => {
  const runtimeRoot = createManagedTempDir('siftkit-caption-db-boundaries-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'boundary-message',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'one image',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA=='],
    imageMeta: [imageMetadata()],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  assert.throws(
    () => updateChatMessageImageCaption(runtimeRoot, session.id, 'missing', 0, 'caption'),
    ChatMessageImageNotFoundError,
  );
  assert.throws(
    () => updateChatMessageImageCaption(runtimeRoot, session.id, message.id, 7, 'caption'),
    /Image not found/u,
  );
  assert.throws(
    () => updateChatMessageImageCaption(runtimeRoot, session.id, message.id, -1, 'caption'),
    /non-negative integer/u,
  );
  assert.throws(
    () => updateChatMessageImageCaption(runtimeRoot, session.id, message.id, 0, '   '),
    /caption is required/u,
  );
  assert.throws(
    () => updateChatMessageImageCaption(runtimeRoot, session.id, 'missing-session-message', 0, 'caption'),
    ChatMessageImageNotFoundError,
  );
  const missingSessionRoot = createManagedTempDir('siftkit-caption-db-missing-session-');
  assert.throws(
    () => updateChatMessageImageCaption(missingSessionRoot, session.id, message.id, 0, 'caption'),
    ChatMessageImageNotFoundError,
  );

  const noMetaMessage = { ...message, id: 'no-meta', imageMeta: undefined };
  saveChatSession(runtimeRoot, { ...session, messages: [noMetaMessage] });
  assert.throws(
    () => updateChatMessageImageCaption(runtimeRoot, session.id, noMetaMessage.id, 0, 'caption'),
    ChatMessageImageNotFoundError,
  );
  const noImageMessage = { ...message, id: 'no-image', images: [], imageMeta: message.imageMeta };
  saveChatSession(runtimeRoot, { ...session, messages: [noImageMessage] });
  assert.throws(
    () => updateChatMessageImageCaption(runtimeRoot, session.id, noImageMessage.id, 0, 'caption'),
    ChatMessageImageNotFoundError,
  );
});

test('caption route reports an unknown message as an image-not-found error', async () => {
  const tempRoot = createManagedTempDir('siftkit-caption-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'caption route' }),
    });
    assert.equal(created.statusCode, 200);
    const sessionId = String(asObject(created.body.session).id);
    const response = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: 'missing', imageIndex: 0 }),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, 'Image not found.');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('caption route performs one mocked vision pass and persists its caption', async () => {
  const tempRoot = createManagedTempDir('siftkit-caption-inference-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  const activePreset = getActiveModelPreset(config);
  activePreset.Backend = 'exl3';
  activePreset.VisionEnabled = true;
  activePreset.VisionImageRetention = 8;
  writeConfig(getConfigPath(), config);
  const runtimeRoot = path.dirname(getConfigPath());
  const session = createTestChatSession(runtimeRoot);
  session.modelPresetId = activePreset.id;
  session.modelPreset = activePreset;
  const image = toDataUrl('image/png', rasterBuffer('png', 1, 1));
  const message = {
    id: 'caption-message',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'describe this',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: [image],
    imageMeta: [imageMetadata()],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await requestJson(`${baseUrl}/dashboard/chat/sessions/${session.id}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: message.id, imageIndex: 0, mockResponses: [{ content: "  A login screen.  " }] }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.caption, 'A login screen.');
    const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
    assert.equal(reloaded?.messages?.[0]?.imageMeta?.[0]?.caption, 'A login screen.');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('a sequential caption request returns the persisted caption without a second engine pass', async () => {
  const harness = await withCaptionServer();
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  let calls = 0;
  StatusEngineService.prototype.executeRepoSearch = async function executeRepoSearchWithCount(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    calls += 1;
    return originalExecute.call(this, request);
  };
  try {
    const url = `${harness.baseUrl}/dashboard/chat/sessions/${harness.fixture.session.id}/images/caption`;
    const first = await requestJson(url, {
      method: 'POST',
      body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 0, mockResponses: [{ content: "first caption" }] }),
    });
    const second = await requestJson(url, {
      method: 'POST',
      body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 0, mockResponses: [{ content: "second caption" }] }),
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.caption, 'first caption');
    assert.equal(second.body.caption, 'first caption');
    assert.equal(calls, 1);
  } finally {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
    await closeCaptionTestServer(harness.server, harness.previousCwd, harness.envBackup, harness.tempRoot);
  }
});

test('concurrent duplicate caption requests execute one vision pass and share its persisted result', async () => {
  const harness = await withCaptionServer();
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  let calls = 0;
  StatusEngineService.prototype.executeRepoSearch = async function executeRepoSearchWithDelay(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    calls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    return originalExecute.call(this, request);
  };
  try {
    const url = `${harness.baseUrl}/dashboard/chat/sessions/${harness.fixture.session.id}/images/caption`;
    const [first, second] = await Promise.all([
      requestJson(url, {
        method: 'POST',
        body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 0, mockResponses: [{ content: "concurrent caption" }] }),
      }),
      requestJson(url, {
        method: 'POST',
        body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 0, mockResponses: [{ content: "other caption" }] }),
      }),
    ]);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.caption, 'concurrent caption');
    assert.equal(second.body.caption, 'concurrent caption');
    assert.equal(calls, 1);
  } finally {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
    await closeCaptionTestServer(harness.server, harness.previousCwd, harness.envBackup, harness.tempRoot);
  }
});

test('caption route rejects malformed bodies and missing image targets with explicit 4xx statuses', async () => {
  const harness = await withCaptionServer();
  try {
    const url = `${harness.baseUrl}/dashboard/chat/sessions/${harness.fixture.session.id}/images/caption`;
    const malformed = await requestJson(url, {
      method: 'POST',
      body: JSON.stringify({ messageId: harness.fixture.message.id }),
    });
    const missingIndex = await requestJson(url, {
      method: 'POST',
      body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 7 }),
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(missingIndex.statusCode, 404);
    assert.equal(missingIndex.body.error, 'Image not found.');
  } finally {
    await closeCaptionTestServer(harness.server, harness.previousCwd, harness.envBackup, harness.tempRoot);
  }

  const noMetaHarness = await withCaptionServer({ withMetadata: false });
  try {
    const response = await requestJson(`${noMetaHarness.baseUrl}/dashboard/chat/sessions/${noMetaHarness.fixture.session.id}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: noMetaHarness.fixture.message.id, imageIndex: 0 }),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, 'Image not found.');
  } finally {
    await closeCaptionTestServer(noMetaHarness.server, noMetaHarness.previousCwd, noMetaHarness.envBackup, noMetaHarness.tempRoot);
  }
});

test('caption route uses the session snapshot when the global active preset changes', async () => {
  const harness = await withCaptionServer({ snapshotPreset: true });
  try {
    const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${harness.fixture.session.id}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 0, mockResponses: [{ content: "snapshot caption" }] }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.caption, 'snapshot caption');
  } finally {
    await closeCaptionTestServer(harness.server, harness.previousCwd, harness.envBackup, harness.tempRoot);
  }
});

test('caption route reports distinct vision and retention guards', async () => {
  const visionOffHarness = await withCaptionServer({ visionEnabled: false });
  try {
    const response = await requestJson(`${visionOffHarness.baseUrl}/dashboard/chat/sessions/${visionOffHarness.fixture.session.id}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: visionOffHarness.fixture.message.id, imageIndex: 0 }),
    });
    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), /Vision is not enabled for this preset/u);
  } finally {
    await closeCaptionTestServer(visionOffHarness.server, visionOffHarness.previousCwd, visionOffHarness.envBackup, visionOffHarness.tempRoot);
  }

  const retentionOffHarness = await withCaptionServer({ visionImageRetention: 0 });
  try {
    const response = await requestJson(`${retentionOffHarness.baseUrl}/dashboard/chat/sessions/${retentionOffHarness.fixture.session.id}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: retentionOffHarness.fixture.message.id, imageIndex: 0 }),
    });
    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), /VisionImageRetention = 0/u);
  } finally {
    await closeCaptionTestServer(retentionOffHarness.server, retentionOffHarness.previousCwd, retentionOffHarness.envBackup, retentionOffHarness.tempRoot);
  }
});

test('caption route returns 500 when inference produces an empty final output', async () => {
  const harness = await withCaptionServer();
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  StatusEngineService.prototype.executeRepoSearch = async function executeRepoSearchWithEmptyOutput(
    _request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    return mockedCaptionExecution('   ');
  };
  try {
    const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${harness.fixture.session.id}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 0 }),
    });
    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), /empty caption/u);
  } finally {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
    await closeCaptionTestServer(harness.server, harness.previousCwd, harness.envBackup, harness.tempRoot);
  }
});

test('caption route returns 404 when the image disappears during inference', async () => {
  const harness = await withCaptionServer();
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  StatusEngineService.prototype.executeRepoSearch = async function executeRepoSearchAfterDeletion(
    request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    deleteChatMessage(harness.fixture.runtimeRoot, harness.fixture.session.id, harness.fixture.message.id);
    return originalExecute.call(this, request);
  };
  try {
    const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${harness.fixture.session.id}/images/caption`, {
      method: 'POST',
      body: JSON.stringify({ messageId: harness.fixture.message.id, imageIndex: 0, mockResponses: [{ content: "will be discarded" }] }),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, 'Image not found.');
  } finally {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
    await closeCaptionTestServer(harness.server, harness.previousCwd, harness.envBackup, harness.tempRoot);
  }
});

test('the message route persists admitted image metadata on the user message', async () => {
  const context = await withCaptionServer();
  try {
    const image = toDataUrl('image/png', rasterBuffer('png', 4, 4));
    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content: 'what is this', images: [image], assistantContent: 'a tiny square' }),
      },
    );
    assert.equal(response.statusCode, 200);

    const stored = readChatSessionFromPath(
      getChatSessionPath(context.fixture.runtimeRoot, context.fixture.session.id),
    );
    const appendedUserMessage = stored?.messages?.filter((message) => message.role === 'user').at(-1);
    assert.equal(appendedUserMessage?.images?.length, 1);
    assert.equal(appendedUserMessage?.imageMeta?.length, 1);
    assert.ok((appendedUserMessage?.imageMeta?.[0]?.tokenEstimate ?? 0) > 0);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});

test('a chat turn whose run compacted persists the summary row and flags earlier messages', async () => {
  const context = await withCaptionServer();
  saveChatSession(context.fixture.runtimeRoot, {
    ...context.fixture.session,
    messages: [{ ...context.fixture.message, content: 'X'.repeat(32_000) }],
  });
  const originalExecute = StatusEngineService.prototype.executeRepoSearch;
  StatusEngineService.prototype.executeRepoSearch = async function executeCompactedRun(
    this: StatusEngineService,
    _request: RepoSearchExecutionRequest,
  ): Promise<RepoSearchExecutionResult> {
    return mockedCaptionExecution('the fresh answer', 'SUMMARY OF PRIOR CONVERSATION');
  };
  try {
    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages`,
      { method: 'POST', body: JSON.stringify({ content: 'a new question' }) },
    );
    assert.equal(response.statusCode, 200);
    const usage = asObject(response.body.contextUsage);
    assert.equal(usage.shouldCondense, false);
    assert.ok(Number(usage.totalUsedTokens) < 2000);
    assert.ok(Number(usage.remainingTokens) > Number(usage.warnThresholdTokens));

    const stored = readChatSessionFromPath(
      getChatSessionPath(context.fixture.runtimeRoot, context.fixture.session.id),
    );
    const messages = stored?.messages ?? [];
    const summaryIndex = messages.findIndex((message) => message.kind === 'compaction_summary');
    assert.ok(summaryIndex >= 0);
    assert.equal(messages[summaryIndex]?.content, 'SUMMARY OF PRIOR CONVERSATION');
    assert.ok(summaryIndex > 0);
    assert.equal(messages.slice(0, summaryIndex).every((message) => message.compressedIntoSummary === true), true);
    assert.equal(messages.slice(summaryIndex).every((message) => message.compressedIntoSummary !== true), true);
    assert.equal(
      messages.filter(
        (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
      ).length,
      1,
    );
  } finally {
    StatusEngineService.prototype.executeRepoSearch = originalExecute;
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});

test('deleteChatMessageImage strips one image and records the removal without editing the text', () => {
  const runtimeRoot = createManagedTempDir('siftkit-delete-image-db-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'two-images',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'compare these',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='],
    imageMeta: [imageMetadata(), imageMetadata(2, 2, 'keep me')],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  deleteChatMessageImage(runtimeRoot, session.id, message.id, 0);

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
  assert.deepEqual(reloaded?.messages?.[0]?.images, ['data:image/png;base64,BB==']);
  assert.equal(reloaded?.messages?.[0]?.imageMeta?.length, 1);
  assert.equal(reloaded?.messages?.[0]?.imageMeta?.[0]?.caption, 'keep me');
  assert.equal(reloaded?.messages?.[0]?.content, 'compare these');
  assert.equal(reloaded?.messages?.[0]?.removedImageCount, 1);
});

test('deleteChatMessageImage rejects missing targets and invalid boundaries', () => {
  const runtimeRoot = createManagedTempDir('siftkit-delete-image-boundaries-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'one-image',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'one image',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA=='],
    imageMeta: [imageMetadata()],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  assert.throws(
    () => deleteChatMessageImage(runtimeRoot, session.id, 'missing', 0),
    ChatMessageImageNotFoundError,
  );
  assert.throws(
    () => deleteChatMessageImage(runtimeRoot, session.id, message.id, 7),
    ChatMessageImageNotFoundError,
  );
  assert.throws(
    () => deleteChatMessageImage(runtimeRoot, session.id, message.id, -1),
    /non-negative integer/u,
  );
});

test('deleteChatMessageImage counts every removal separately', () => {
  const runtimeRoot = createManagedTempDir('siftkit-delete-image-marker-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'two-images-marker',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'compare these',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='],
    imageMeta: [imageMetadata(), imageMetadata()],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  deleteChatMessageImage(runtimeRoot, session.id, message.id, 0);
  deleteChatMessageImage(runtimeRoot, session.id, message.id, 0);

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
  assert.deepEqual(reloaded?.messages?.[0]?.images, []);
  assert.equal(reloaded?.messages?.[0]?.content, 'compare these');
  assert.equal(reloaded?.messages?.[0]?.removedImageCount, 2);
});

test('deleteChatMessageImage leaves a literal removal phrase typed by the user alone', () => {
  const runtimeRoot = createManagedTempDir('siftkit-delete-image-literal-');
  const session = createTestChatSession(runtimeRoot);
  const message = {
    id: 'literal-marker',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'the log line reads [image removed] verbatim',
    inputTokensEstimate: 1,
    outputTokensEstimate: 1,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
    images: ['data:image/png;base64,AA=='],
    imageMeta: [imageMetadata()],
  };
  saveChatSession(runtimeRoot, { ...session, messages: [message] });

  deleteChatMessageImage(runtimeRoot, session.id, message.id, 0);

  const reloaded = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
  assert.equal(reloaded?.messages?.[0]?.content, 'the log line reads [image removed] verbatim');
  assert.equal(reloaded?.messages?.[0]?.removedImageCount, 1);
});

test('deleting one image returns the session with reduced context usage', async () => {
  const context = await withCaptionServer();
  try {
    const before = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}`,
    );
    assert.equal(before.statusCode, 200);
    assert.ok(Number(asObject(before.body.contextUsage).imageUsedTokens) > 0);

    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages/${context.fixture.message.id}/images/0`,
      { method: 'DELETE' },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(Number(asObject(response.body.contextUsage).imageUsedTokens), 0);

    const stored = readChatSessionFromPath(
      getChatSessionPath(context.fixture.runtimeRoot, context.fixture.session.id),
    );
    assert.deepEqual(stored?.messages?.[0]?.images, []);
    assert.equal(stored?.messages?.[0]?.removedImageCount, 1);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});

test('deleting an out-of-range image index answers 404', async () => {
  const context = await withCaptionServer();
  try {
    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages/${context.fixture.message.id}/images/7`,
      { method: 'DELETE' },
    );
    assert.equal(response.statusCode, 404);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});

test('deleting an image on an unknown message answers 404', async () => {
  const context = await withCaptionServer();
  try {
    const response = await requestJson(
      `${context.baseUrl}/dashboard/chat/sessions/${context.fixture.session.id}/messages/no-such-message/images/0`,
      { method: 'DELETE' },
    );
    assert.equal(response.statusCode, 404);
  } finally {
    await closeCaptionTestServer(context.server, context.previousCwd, context.envBackup, context.tempRoot);
  }
});
