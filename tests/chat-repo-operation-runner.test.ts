import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getConfiguredModel } from '../src/config/getters.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from '../src/repo-search/types.js';
import {
  ChatRepoOperationRunner,
  type ChatRepoOperationRequest,
} from '../src/status-server/chat-repo-operation-runner.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import {
  closeRuntimeDatabase,
} from '../src/state/runtime-db.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { buildMockScorecard } from './_test-helpers.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';
import { readImageDimensions } from '../src/llm-protocol/image-admission.js';
import { ManagedLlamaStartupError } from '../src/status-server/managed-llama.js';

class RecordingProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

class StubStatusEngineService extends StatusEngineService {
  request: RepoSearchExecutionRequest | null = null;

  constructor(
    private readonly result: RepoSearchExecutionResult,
    private readonly failure: Error | null = null,
  ) {
    super();
  }

  override async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    this.request = request;
    request.progressWriter?.write({ kind: 'context_warning', warningText: 'autoload skipped', elapsedMs: 0 });
    request.progressWriter?.write({ kind: 'thinking', thinkingText: 'inspect files', turn: 1, maxTurns: 7 });
    request.progressWriter?.write({
      kind: 'tool_start',
      toolCallId: 'tool-1',
      turn: 1,
      maxTurns: 7,
      command: 'rg -n "target" src',
      promptTokenCount: 1_200,
      elapsedMs: 10,
    });
    request.progressWriter?.write({
      kind: 'tool_result',
      toolCallId: 'tool-1',
      turn: 1,
      maxTurns: 7,
      command: 'rg -n "target" src',
      exitCode: 0,
      outputSnippet: 'src/main.ts:4:target',
      outputTokens: 8,
      outputTokensEstimated: false,
      promptTokenCount: 1_200,
      elapsedMs: 20,
    });
    if (this.failure) {
      throw this.failure;
    }
    return this.result;
  }
}

function buildResult(finalOutput: string): RepoSearchExecutionResult {
  const scorecard = buildMockScorecard(finalOutput);
  const task = scorecard.tasks[0];
  if (!task) {
    throw new Error('Mock scorecard must contain a task.');
  }
  task.turnThinking = { 1: 'inspect files' };
  task.commands = [{
    command: 'rg -n "target" src',
    turn: 1,
    modelVisibleCommand: 'rg -n "target" src',
    safe: true,
    reason: null,
    exitCode: 0,
    output: 'src/main.ts:4:target',
    promptOutput: 'src/main.ts:4:target',
    outputTokens: 4,
    outputTokensEstimated: false,
  }];
  scorecard.totals.promptTokens = 20;
  scorecard.totals.promptCacheTokens = 3;
  scorecard.totals.promptEvalTokens = 10;
  scorecard.totals.promptEvalDurationMs = 500;
  scorecard.totals.outputTokens = 8;
  scorecard.totals.outputTokensEstimatedCount = 1;
  scorecard.totals.thinkingTokens = 2;
  scorecard.totals.thinkingTokensEstimatedCount = 1;
  scorecard.totals.generationDurationMs = 1_000;
  scorecard.totals.speculativeAcceptedTokens = 4;
  scorecard.totals.speculativeGeneratedTokens = 5;
  task.groundingStatus = 'fetched';
  return {
    requestId: 'engine-request',
    transcriptPath: 'transcript.jsonl',
    artifactPath: 'artifact.json',
    scorecard,
  };
}

function createSession(): ChatSession {
  return {
    id: 'session-1',
    title: 'Session',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'test-model', NumCtx: 4096 }),
    thinkingEnabled: true,
    webSearchEnabled: false,
    presetId: 'summary',
    mode: 'chat',
    planRepoRoot: process.cwd(),
    createdAtUtc: '2026-07-28T00:00:00.000Z',
    updatedAtUtc: '2026-07-28T00:00:00.000Z',
    messages: [],
  };
}

function createRequest(
  runtimeRoot: string,
  engineService: StatusEngineService,
  progressWriter: ProgressWriter<RepoSearchProgressEvent>,
): ChatRepoOperationRequest {
  const config = getDefaultConfigObject();
  const activeModelPreset = config.Server.ModelPresets.Presets.find(
    (preset) => preset.id === config.Server.ModelPresets.ActivePresetId,
  );
  if (!activeModelPreset) {
    throw new Error('Default config must contain its active model preset.');
  }
  activeModelPreset.Model = 'test-model';
  const session = createSession();
  session.modelPresetId = activeModelPreset.id;
  return {
    runtimeRoot,
    session,
    config,
    content: 'find target',
    images: [],
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:4765/status',
    engineService,
    progressWriter,
    requestId: 'route-request',
    maxTurns: 7,
    logFile: 'operation.log',
    availableModels: ['test-model'],
    mockResponses: [{ content: "done" }],
    mockCommandResults: {},
    managedLlamaRunId: null,
  };
}

test('chat repo operation runner executes and persists equivalent plan and repo-search data', async () => {
  for (const operation of ['plan', 'repo-search'] as const) {
    const runtimeRoot = createManagedTempDir(`siftkit-chat-${operation}-`);
    const progressWriter = new RecordingProgressWriter();
    const engineResult = buildResult(`${operation} complete`);
    if (operation === 'plan') {
      const task = engineResult.scorecard.tasks[0];
      if (!task) {
        throw new Error('Mock scorecard must contain a task.');
      }
      task.turnThinking = { 1: '' };
    }
    const engineService = new StubStatusEngineService(engineResult);
    try {
      const runner = new ChatRepoOperationRunner();
      const request = createRequest(runtimeRoot, engineService, progressWriter);
      request.images = [toDataUrl('image/png', rasterBuffer('png', 1, 1))];
      const activePreset = request.config.Server.ModelPresets.Presets.find(
        (preset) => preset.id === request.config.Server.ModelPresets.ActivePresetId,
      );
      if (!activePreset) {
        throw new Error('Default config must contain its active model preset.');
      }
      activePreset.Backend = 'exl3';
      activePreset.VisionEnabled = true;
      if (operation === 'repo-search') {
        request.maxTurns = undefined;
        request.session.webSearchEnabled = true;
      }
      const result = operation === 'plan'
        ? await runner.runPlan(request)
        : await runner.runRepoSearch(request);
      const engineRequest = engineService.request;
      if (!engineRequest) {
        throw new Error('Expected the engine request to be captured.');
      }

      assert.equal(engineRequest.presetId, operation);
      assert.equal(engineRequest.taskKind, operation);
      assert.equal(engineRequest.repoRoot, process.cwd());
      assert.deepEqual(engineRequest.initialUserImages, request.images);
      assert.equal(engineRequest.requestId, 'route-request');
      assert.equal(engineRequest.maxTurns, operation === 'plan' ? 7 : 45);
      // The session drives the engine through its config, not a separate model argument.
      assert.equal(engineRequest.model, undefined);
      if (!engineRequest.config) {
        throw new Error('Expected the engine request to carry a config.');
      }
      assert.equal(getConfiguredModel(engineRequest.config), 'test-model');
      // Web tools are always in the surface; per-session intent travels on webToolsEnabled
      // and the web tool policy decides whether they are actually offered.
      assert.equal(engineRequest.allowedTools?.includes('web_search'), true);
      assert.equal(engineRequest.allowedTools?.includes('web_fetch'), true);
      assert.equal(engineRequest.webToolsEnabled, operation === 'repo-search');
      assert.match(engineRequest.prompt, operation === 'plan' ? /implementation plan/u : /^find target$/u);
      assert.equal(result.updatedSession.presetId, operation);
      assert.equal(result.updatedSession.mode, operation);
      assert.equal(result.updatedSession.planRepoRoot, process.cwd());
      assert.deepEqual(
        result.updatedSession.messages?.map((message) => message.kind),
        operation === 'plan'
          ? ['user_text', 'assistant_tool_call', 'assistant_answer']
          : ['user_text', 'assistant_thinking', 'assistant_tool_call', 'assistant_answer'],
      );
      assert.deepEqual(
        result.updatedSession.messages?.find((message) => message.kind === 'user_text')?.images,
        request.images,
      );
      const answer = result.updatedSession.messages?.find((message) => message.kind === 'assistant_answer');
      assert.equal(answer?.outputTokensEstimate, 8);
      assert.equal(answer?.outputTokensEstimated, true);
      assert.equal(answer?.thinkingTokens, 2);
      assert.equal(answer?.thinkingTokensEstimated, true);
      assert.equal(answer?.promptCacheTokens, 3);
      assert.equal(answer?.promptEvalTokens, 10);
      assert.equal(answer?.promptTokensPerSecond, 20);
      assert.equal(answer?.generationTokensPerSecond, 10);
      assert.equal(answer?.speculativeAcceptedTokens, 4);
      assert.equal(answer?.speculativeGeneratedTokens, 5);
      assert.equal(answer?.groundingStatus, operation === 'repo-search' ? 'fetched' : null);
      assert.equal(result.repoSearch.requestId, 'engine-request');
      assert.equal(result.repoSearch.transcriptPath, 'transcript.jsonl');
      assert.equal(result.repoSearch.artifactPath, 'artifact.json');
      assert.equal(result.repoSearch.scorecard.tasks[0]?.finalOutput, `${operation} complete`);
      assert.deepEqual(
        progressWriter.events.map((event) => event.kind),
        ['context_warning', 'thinking', 'tool_start', 'tool_result'],
      );
    } finally {
      closeRuntimeDatabase();
      fs.rmSync(runtimeRoot, { force: true, recursive: true });
    }
  }
});

test('chat repo operation runner propagates engine failures without persisting messages', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-chat-failure-');
  const engineService = new StubStatusEngineService(buildResult('unused'), new Error('engine failed'));
  try {
    const runner = new ChatRepoOperationRunner();
    await assert.rejects(
      runner.runPlan(createRequest(runtimeRoot, engineService, new RecordingProgressWriter())),
      /engine failed/u,
    );
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'runtime.sqlite')), false);
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(runtimeRoot, { force: true, recursive: true });
  }
});

test('chat repo operation runner labels image-encode GPU OOMs with the image-size guidance', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-chat-image-oom-');
  const engineService = new StubStatusEngineService(
    buildResult('unused'),
    new Error('torch.cuda.OutOfMemoryError: CUDA out of memory.'),
  );
  try {
    const request = createRequest(runtimeRoot, engineService, new RecordingProgressWriter());
    const activePreset = request.config.Server.ModelPresets.Presets.find(
      (preset) => preset.id === request.config.Server.ModelPresets.ActivePresetId,
    );
    if (!activePreset) {
      throw new Error('Default config must contain its active model preset.');
    }
    activePreset.Backend = 'exl3';
    activePreset.VisionEnabled = true;
    activePreset.VisionMaxImagePixels = 2_097_152;
    request.images = [toDataUrl('image/png', rasterBuffer('png', 1, 1))];

    await assert.rejects(
      () => new ChatRepoOperationRunner().runPlan(request),
      (error: Error) => {
        assert.match(error.message, /encoding an image/u);
        assert.match(error.message, /2\.1 MP/u);
        assert.doesNotMatch(error.message, /torch\.cuda\.OutOfMemoryError/u);
        return true;
      },
    );
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(runtimeRoot, { force: true, recursive: true });
  }
});

test('chat repo operation runner keeps typed startup OOMs on startup guidance even with images', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-chat-startup-oom-');
  const engineService = new StubStatusEngineService(
    buildResult('unused'),
    new ManagedLlamaStartupError(
      'Managed llama.cpp ran out of GPU memory during startup.',
      { kind: 'gpu_memory_oom', requiredMiB: 24_000, availableMiB: 800 },
    ),
  );
  try {
    const request = createRequest(runtimeRoot, engineService, new RecordingProgressWriter());
    const activePreset = request.config.Server.ModelPresets.Presets.find(
      (preset) => preset.id === request.config.Server.ModelPresets.ActivePresetId,
    );
    if (!activePreset) {
      throw new Error('Default config must contain its active model preset.');
    }
    activePreset.Backend = 'exl3';
    activePreset.VisionEnabled = true;
    activePreset.VisionMaxImagePixels = 2_097_152;
    request.images = [toDataUrl('image/png', rasterBuffer('png', 1, 1))];

    await assert.rejects(
      () => new ChatRepoOperationRunner().runPlan(request),
      (error: Error) => {
        assert.match(error.message, /context length|CacheRam/u);
        assert.doesNotMatch(error.message, /Max image size|VisionMaxImagePixels/u);
        return true;
      },
    );
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(runtimeRoot, { force: true, recursive: true });
  }
});

test('chat repo operation runner keeps text-only GPU OOMs unlabelled as image encoding', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-chat-text-oom-');
  const engineService = new StubStatusEngineService(
    buildResult('unused'),
    new Error('cudaMalloc failed: out of memory'),
  );
  try {
    const request = createRequest(runtimeRoot, engineService, new RecordingProgressWriter());

    await assert.rejects(
      () => new ChatRepoOperationRunner().runPlan(request),
      (error: Error) => {
        assert.equal(error.message, 'cudaMalloc failed: out of memory');
        assert.doesNotMatch(error.message, /encoding an image/u);
        return true;
      },
    );
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(runtimeRoot, { force: true, recursive: true });
  }
});

test('chat repo operation runner admits oversized images before engine and persistence for both operations', async () => {
  const oversizedUrl = toDataUrl('image/png', rasterBuffer('png', 2000, 1000));
  for (const operation of ['plan', 'repo-search'] as const) {
    const runtimeRoot = createManagedTempDir(`siftkit-chat-admit-${operation}-`);
    const engineService = new StubStatusEngineService(buildResult(`${operation} complete`));
    try {
      const request = createRequest(runtimeRoot, engineService, new RecordingProgressWriter());
      const activePreset = request.config.Server.ModelPresets.Presets.find(
        (preset) => preset.id === request.config.Server.ModelPresets.ActivePresetId,
      );
      if (!activePreset) {
        throw new Error('Default config must contain its active model preset.');
      }
      activePreset.Backend = 'exl3';
      activePreset.VisionEnabled = true;
      activePreset.VisionMaxImagePixels = 500_000;
      request.images = [oversizedUrl];
      const result = operation === 'plan'
        ? await new ChatRepoOperationRunner().runPlan(request)
        : await new ChatRepoOperationRunner().runRepoSearch(request);
      const engineRequest = engineService.request;
      if (!engineRequest) {
        throw new Error('Expected the engine request to be captured.');
      }
      const admittedUrl = engineRequest.initialUserImages?.[0];
      assert.ok(admittedUrl);
      assert.notEqual(admittedUrl, oversizedUrl);
      const separator = admittedUrl.indexOf(';base64,');
      const dimensions = readImageDimensions(
        Buffer.from(admittedUrl.slice(separator + ';base64,'.length), 'base64'),
        admittedUrl.slice('data:'.length, separator),
      );
      assert.ok(dimensions.width * dimensions.height <= 500_000);
      const persisted = result.updatedSession.messages?.find((message) => message.kind === 'user_text');
      assert.deepEqual(persisted?.images, [admittedUrl]);
      assert.notDeepEqual(persisted?.images, request.images);
    } finally {
      closeRuntimeDatabase();
      fs.rmSync(runtimeRoot, { force: true, recursive: true });
    }
  }
});

test('chat repo operation runner rejects repo-search images when the selected model lacks vision', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-chat-vision-off-');
  const engineService = new StubStatusEngineService(buildResult('unused'));
  try {
    const request = createRequest(runtimeRoot, engineService, new RecordingProgressWriter());
    const activePreset = request.config.Server.ModelPresets.Presets.find(
      (preset) => preset.id === request.config.Server.ModelPresets.ActivePresetId,
    );
    if (!activePreset) {
      throw new Error('Default config must contain its active model preset.');
    }
    activePreset.Backend = 'exl3';
    activePreset.VisionEnabled = false;
    request.images = ['data:image/png;base64,AAAA'];

    await assert.rejects(
      () => new ChatRepoOperationRunner().runRepoSearch(request),
      /Vision is not enabled for this preset/u,
    );
    assert.equal(engineService.request, null);
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(runtimeRoot, { force: true, recursive: true });
  }
});

test('chat repo operation runner rejects plan images when image retention is zero', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-chat-retention-zero-');
  const engineService = new StubStatusEngineService(buildResult('unused'));
  try {
    const request = createRequest(runtimeRoot, engineService, new RecordingProgressWriter());
    const activePreset = request.config.Server.ModelPresets.Presets.find(
      (preset) => preset.id === request.config.Server.ModelPresets.ActivePresetId,
    );
    if (!activePreset) {
      throw new Error('Default config must contain its active model preset.');
    }
    activePreset.Backend = 'exl3';
    activePreset.VisionEnabled = true;
    activePreset.VisionImageRetention = 0;
    request.images = ['data:image/png;base64,AAAA'];

    await assert.rejects(
      () => new ChatRepoOperationRunner().runPlan(request),
      /Image input is disabled for this preset \(VisionImageRetention = 0\)/u,
    );
    assert.equal(engineService.request, null);
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(runtimeRoot, { force: true, recursive: true });
  }
});
