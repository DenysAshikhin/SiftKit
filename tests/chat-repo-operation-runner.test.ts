import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
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
    request.progressWriter?.write({ kind: 'context_warning', warningText: 'autoload skipped' });
    request.progressWriter?.write({ kind: 'thinking', thinkingText: 'inspect files' });
    request.progressWriter?.write({
      kind: 'tool_start',
      toolCallId: 'tool-1',
      turn: 1,
      maxTurns: 7,
      command: 'rg -n "target" src',
    });
    request.progressWriter?.write({
      kind: 'tool_result',
      toolCallId: 'tool-1',
      turn: 1,
      maxTurns: 7,
      command: 'rg -n "target" src',
      exitCode: 0,
      outputSnippet: 'src/main.ts:4:target',
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
    model: 'test-model',
    contextWindowTokens: 4096,
    thinkingEnabled: true,
    webSearchEnabled: false,
    presetId: 'summary',
    mode: 'chat',
    planRepoRoot: process.cwd(),
    condensedSummary: '',
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
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:4765/status',
    engineService,
    progressWriter,
    requestId: 'route-request',
    maxTurns: 7,
    logFile: 'operation.log',
    availableModels: ['test-model'],
    mockResponses: ['{"action":"finish","output":"done"}'],
    mockCommandResults: {},
    managedLlamaRunId: null,
  };
}

test('chat repo operation runner executes and persists equivalent plan and repo-search data', async () => {
  for (const operation of ['plan', 'repo-search'] as const) {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `siftkit-chat-${operation}-`));
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
      assert.equal(engineRequest.requestId, 'route-request');
      assert.equal(engineRequest.maxTurns, operation === 'plan' ? 7 : 45);
      assert.equal(engineRequest.model, 'test-model');
      assert.equal(engineRequest.allowedTools?.includes('web_search'), operation === 'repo-search');
      assert.equal(engineRequest.allowedTools?.includes('web_fetch'), operation === 'repo-search');
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
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-failure-'));
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
