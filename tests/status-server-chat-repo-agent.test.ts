import assert from 'node:assert/strict';
import { readChatStream, readChatStreamViews, readSettledChatSession } from './helpers/chat-stream-views.js';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

import {
  ActiveChatRepoAgentResponseSchema,
  ChatRepoAgentApprovalModeResponseSchema,
  ChatSessionResponseSchema,
} from '@siftkit/contracts';

import type { JsonObject } from '../src/lib/json-types.js';
import { RepoAgentRunResultSchema } from '../src/repo-agent/run-schemas.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { buildRepoToolRequestedCommand } from '../src/repo-search/engine/repo-tools.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import { getActiveModelPreset, readConfig, writeConfig } from '../src/status-server/config-store.js';
import { awaitRepoSearchRunPersistence } from '../src/repo-search/execute.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
import { asObject, requestJson, requestSse, type SseResponse } from './helpers/dashboard-http.js';
import { requestSse as requestOperationSse } from './helpers/sse-http.js';
import { OutputCapture } from './helpers/stdout-capture.js';
import { startHarness, type StreamedOperationHarness } from './helpers/streamed-op-harness.js';
import { HoldingCaptureEngineService } from './helpers/holding-capture-engine-service.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { findPlannerContextViolation } from '../src/repo-search/planner-chat-message.js';
import { replayChatContext } from '../src/status-server/chat-context-replay.js';

const ACTIVE_RUN_TIMEOUT_MS = 5_000;
const OPERATION_A = '4f9c1f9a-0000-4000-8000-000000000000';
const OPERATION_B = '4f9c1f9a-0000-4000-8000-000000000001';

class EngineGate {
  readonly promise: Promise<void>;
  private resolvePromise: (() => void) | null = null;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  release(): void {
    const resolve = this.resolvePromise;
    if (!resolve) {
      throw new Error('Engine gate is not initialized.');
    }
    resolve();
  }
}

class CapturingEngineService extends StatusEngineService {
  readonly requests: RepoSearchExecutionRequest[] = [];

  override executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    this.requests.push(request);
    return super.executeRepoSearch(request);
  }
}

class GatedEngineService extends StatusEngineService {
  constructor(private readonly gate: EngineGate) {
    super();
  }

  override async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    if (request.prompt === 'hold generation') {
      await this.gate.promise;
    }
    return await super.executeRepoSearch(request);
  }
}

async function createSession(
  harness: StreamedOperationHarness,
  title: string,
  presetId = 'chat',
): Promise<string> {
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, {
    method: 'POST',
    body: JSON.stringify({ title, presetId }),
  });
  assert.equal(response.statusCode, 200);
  const sessionId = asObject(response.body.session).id;
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('Expected the chat session create response to contain an id.');
  }
  return sessionId;
}

function installRepoAgentPreset(maxTurns: number): string {
  const configPath = getRuntimeDatabasePath();
  const config = readConfig(configPath);
  const repoAgentPreset = config.Presets.find((preset) => preset.id === 'repo-agent');
  if (!repoAgentPreset) {
    throw new Error('Default config has no repo-agent preset.');
  }
  const id = `custom-repo-agent-${maxTurns}`;
  config.Presets = [
    ...config.Presets,
    {
      ...repoAgentPreset,
      id,
      label: `Custom Repo Agent ${maxTurns}`,
      builtin: false,
      deletable: true,
      maxTurns,
    },
  ];
  writeConfig(configPath, config);
  return id;
}

function getCapturedRepoAgentRequest(
  engineService: CapturingEngineService,
  prompt: string,
): RepoSearchExecutionRequest {
  const request = engineService.requests.find((entry) => entry.prompt === prompt);
  if (!request) {
    throw new Error(`Expected a captured repo-agent request for ${prompt}.`);
  }
  return request;
}

async function runSimpleRepoAgentChat(
  harness: StreamedOperationHarness,
  sessionId: string,
  operationId: string,
  maxTurns?: number,
): Promise<SseResponse> {
  return await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'read a file',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId,
        ...(maxTurns === undefined ? {} : { maxTurns }),
        mockResponses: [
          { toolCalls: [{ name: 'read', arguments: { path: 'package.json' } }] },
          ...repoAgentFinishResponses('chat repo-agent done'),
        ],
        mockCommandResults: {},
      }),
    },
  );
}

async function waitForApproval(harness: StreamedOperationHarness, sessionId: string): Promise<JsonObject> {
  const deadline = Date.now() + ACTIVE_RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await requestJson(
      `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
    );
    if (response.statusCode === 200) {
      const active = ActiveChatRepoAgentResponseSchema.parse(response.body);
      if (active.status === 'approval_required') {
        return response.body;
      }
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for the chat repo-agent approval boundary.');
}

async function waitForRunStatus(
  harness: StreamedOperationHarness,
  sessionId: string,
  expectedStatus: string,
): Promise<void> {
  const deadline = Date.now() + ACTIVE_RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await requestJson(
      `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
    );
    if (response.statusCode === 200
      && ActiveChatRepoAgentResponseSchema.parse(response.body).status === expectedStatus) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for chat repo-agent status ${expectedStatus}.`);
}

/** The stream settled cleanly; the session it produced is what the browser reads back afterwards. */
async function readDoneResponse(harness: StreamedOperationHarness, sessionId: string, response: SseResponse): Promise<ReturnType<typeof ChatSessionResponseSchema.parse>> {
  return ChatSessionResponseSchema.parse(await readSettledChatSession(harness.baseUrl, sessionId, response));
}

function cipherThinkingMockResponses() {
  return [
    {
      thinking: 'inspecting the cipher',
      toolCalls: [{ name: 'write', arguments: { path: 'cipher-note.txt', content: 'cipher' } }],
    },
    // approval:'auto' consults the LLM reviewer before the write; without a verdict mock the
    // run parks at approval_required and the chat stream cannot end with a done payload.
    { content: '{"verdict":"approve","reason":"task-scoped write"}' },
    ...repoAgentFinishResponses('done'),
  ];
}

async function startApprovalRun(
  harness: StreamedOperationHarness,
  sessionId: string,
  filename: string,
): Promise<SseResponse> {
  return await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write a file',
        repoRoot: process.cwd(),
        approval: 'interactive',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: filename, content: 'approved' } }] },
          ...repoAgentFinishResponses('wrote it'),
        ],
        mockCommandResults: {},
      }),
    },
  );
}

test('chat repo-agent decision endpoints reject sessions without active runs', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-empty-', t);
  const sessionId = await createSession(harness, 'No run');

  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 409);

  const active = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
  );
  assert.equal(active.statusCode, 404);

  const invalidMocks = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({ content: 'bad mocks', repoRoot: process.cwd(), mockResponses: 'invalid' }),
    },
  );
  assert.equal(invalidMocks.statusCode, 400);
});

test('chat repo-agent approval holds the lease, resumes the stream, and persists an audit row', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-approve-', t, { engineService });
  const sessionId = await createSession(harness, 'Approve run');
  const seeded = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'prior question', assistantContent: 'prior answer' }),
  });
  assert.equal(seeded.statusCode, 200);

  getRuntimeDatabase().exec(`
    CREATE TEMP TRIGGER require_repo_agent_approval_before_answer
    BEFORE INSERT ON chat_messages
    WHEN NEW.kind = 'assistant_answer'
      AND NEW.source_run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM chat_messages
        WHERE session_id = NEW.session_id
          AND kind = 'repo_agent_approval'
          AND source_run_id = NEW.source_run_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'repo-agent approval must precede its answer');
    END;
  `);

  const stream = startApprovalRun(harness, sessionId, 'approved.txt');
  const active = await waitForApproval(harness, sessionId);
  const parsedActive = ActiveChatRepoAgentResponseSchema.parse(active);
  assert.equal(parsedActive.status, 'approval_required');
  assert.equal(parsedActive.approval.command.includes('approved.txt'), true);
  assert.equal('state' in active, false);
  const runId = active.runId;
  assert.equal(typeof runId, 'string');

  const busy = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
    method: 'POST',
    body: JSON.stringify({ content: 'must be rejected while agent runs', operationId: OPERATION_B }),
  });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.body.operationKind, 'repo-agent');

  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  assert.equal(decide.body.runId, runId);
  assert.match(String(decide.body.decidedAtUtc), /^\d{4}-\d{2}-\d{2}T/u);

  const response = await stream;
  assert.equal(response.statusCode, 200);
  const approvalEvent = readChatStreamViews(response, sessionId).find(view => view.snapshot.approval !== null)?.snapshot.approval;
  assert.ok(approvalEvent);
  assert.equal(approvalEvent.runId, runId);
  const completed = await readDoneResponse(harness, sessionId, response);
  const messages = completed.session.messages;
  assert.deepEqual(messages.filter(message => message.kind !== 'assistant_narration' && message.kind !== 'assistant_progress').slice(-4).map((message) => message.kind), [
    'user_text',
    'assistant_tool_call',
    'repo_agent_approval',
    'assistant_answer',
  ]);
  const approval = messages.find(message => message.kind === 'repo_agent_approval');
  assert.equal(approval?.kind, 'repo_agent_approval');
  if (approval?.kind === 'repo_agent_approval') {
    assert.equal(approval.approvalDecision, 'approve');
    assert.equal(approval.approvalReason, null);
  }
  const chatAgentRequest = engineService.requests.find((request) => request.taskKind === 'repo-agent');
  assert.ok(chatAgentRequest);
  // Every row groups by journal identity; that record binds the engine request explicitly.
  const sourceRunIds = [...new Set(messages.slice(-3).map(message => message.sourceRunId))];
  assert.equal(sourceRunIds.length, 1);
  const sourceRunId = sourceRunIds[0];
  assert.ok(sourceRunId);
  assert.equal(new ChatJournalStore(getRuntimeDatabase()).readRun(sourceRunId)?.requestId, chatAgentRequest.requestId);
  assert.equal(chatAgentRequest.prompt, 'write a file');
  assert.deepEqual(chatAgentRequest.history?.map(message => ({ role: message.role, content: message.content })), [
    { role: 'user', content: 'prior question' },
    { role: 'assistant', content: 'prior answer' },
  ]);
  assert.equal(chatAgentRequest.history?.every(message => typeof message.chatMessageId === 'string'), true);
  assert.equal('systemPrompt' in chatAgentRequest, false);

  const inactive = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`,
  );
  assert.equal(inactive.statusCode, 404);

  await requestSse(`${harness.baseUrl}/repo-agent`, {
    method: 'POST',
    timeoutMs: 20_000,
    body: JSON.stringify({
      prompt: 'standalone run',
      repoRoot: process.cwd(),
      approval: 'off',
      model: 'mock-model',
      availableModels: ['mock-model'],
      mockResponses: repoAgentFinishResponses('standalone done'),
      mockCommandResults: {},
    }),
  });
  const standaloneRequest = engineService.requests.find((request) => request.prompt === 'standalone run');
  assert.ok(standaloneRequest);
  assert.equal('history' in standaloneRequest, false);
});

test('chat repo-agent explicit maxTurns overrides the selected preset default', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-explicit-turns-', t, { engineService });
  const presetId = installRepoAgentPreset(23);
  const sessionId = await createSession(harness, 'Explicit turns', presetId);
  const response = await runSimpleRepoAgentChat(harness, sessionId, OPERATION_A, 7);
  assert.equal(response.statusCode, 200);
  const completed = await readDoneResponse(harness, sessionId, response);
  const toolMessage = completed.session.messages.find((message) => message.kind === 'assistant_tool_call');
  assert.ok(toolMessage);
  if (toolMessage?.kind === 'assistant_tool_call') {
    assert.equal(toolMessage.toolCallMaxTurns, 7);
  }
  assert.equal(getCapturedRepoAgentRequest(engineService, 'read a file').maxTurns, 7);
});

test('chat repo-agent omission uses a custom repo-agent preset maxTurns', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-custom-turns-', t, { engineService });
  const presetId = installRepoAgentPreset(23);
  const sessionId = await createSession(harness, 'Custom turns', presetId);
  const response = await runSimpleRepoAgentChat(harness, sessionId, OPERATION_A);
  assert.equal(response.statusCode, 200);
  const completed = await readDoneResponse(harness, sessionId, response);
  const toolMessage = completed.session.messages.find((message) => message.kind === 'assistant_tool_call');
  assert.ok(toolMessage);
  if (toolMessage?.kind === 'assistant_tool_call') {
    assert.equal(toolMessage.toolCallMaxTurns, 23);
  }
  const captured = getCapturedRepoAgentRequest(engineService, 'read a file');
  assert.equal(captured.maxTurns, 23);
  // The engine resolves its prompt from this id, so it must be the admitted preset, not the built-in one.
  assert.equal(captured.presetId, presetId);
});

test('chat repo-agent omission uses the built-in 100-turn default', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-default-turns-', t, { engineService });
  const sessionId = await createSession(harness, 'Built-in turns', 'repo-agent');
  const response = await runSimpleRepoAgentChat(harness, sessionId, OPERATION_A);
  assert.equal(response.statusCode, 200);
  const completed = await readDoneResponse(harness, sessionId, response);
  const toolMessage = completed.session.messages.find((message) => message.kind === 'assistant_tool_call');
  assert.ok(toolMessage);
  if (toolMessage?.kind === 'assistant_tool_call') {
    assert.equal(toolMessage.toolCallMaxTurns, 100);
  }
  assert.equal(getCapturedRepoAgentRequest(engineService, 'read a file').maxTurns, 100);
});

test('chat sessions using the ordinary chat preset run under the built-in repo-agent turn limit', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-chat-preset-', t, { engineService });
  const sessionId = await createSession(harness, 'Ordinary chat preset');
  const response = await runSimpleRepoAgentChat(harness, sessionId, OPERATION_A);
  assert.equal(response.statusCode, 200);
  const completed = await readDoneResponse(harness, sessionId, response);
  const toolMessage = completed.session.messages.find((message) => message.kind === 'assistant_tool_call');
  assert.ok(toolMessage);
  if (toolMessage?.kind === 'assistant_tool_call') {
    assert.equal(toolMessage.toolCallMaxTurns, 100);
  }
  // The built-in repo-agent preset's limit is admitted explicitly rather than left to the engine default.
  assert.equal(getCapturedRepoAgentRequest(engineService, 'read a file').maxTurns, 100);
});

test('a chat repo-agent run forwards the session web-search toggle to the engine', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-web-toggle-', t, { engineService });
  const webEnabledSession = await createSession(harness, 'Web on', 'repo-agent');
  const webDisabledSession = await createSession(harness, 'Web off', 'repo-agent');
  for (const [sessionId, webSearchEnabled] of [[webEnabledSession, true], [webDisabledSession, false]] as const) {
    const update = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ webSearchEnabled }),
    });
    assert.equal(update.statusCode, 200);
  }

  assert.equal((await runSimpleRepoAgentChat(harness, webEnabledSession, OPERATION_A)).statusCode, 200);
  assert.equal((await runSimpleRepoAgentChat(harness, webDisabledSession, OPERATION_B)).statusCode, 200);

  const agentRequests = engineService.requests.filter((request) => request.taskKind === 'repo-agent');
  assert.deepEqual(agentRequests.map((request) => request.webToolsEnabled), [true, false]);
});

test('a repo-agent follow-up receives the preceding repo-agent turn as replayable history', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-repo-agent-follow-up-', t, { engineService });
  const sessionId = await createSession(harness, 'Follow-up context');
  const endpoint = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`;
  const configPath = getRuntimeDatabasePath();
  const config = readConfig(configPath);
  const originalModelPreset = getActiveModelPreset(config);
  const replacementModelPreset = {
    ...originalModelPreset,
    id: 'replacement-model-preset',
    label: 'Replacement model preset',
    NumCtx: originalModelPreset.NumCtx + 1_024,
  };
  config.Server.ModelPresets = {
    Presets: [...config.Server.ModelPresets.Presets, replacementModelPreset],
    ActivePresetId: replacementModelPreset.id,
  };
  writeConfig(configPath, config);

  const firstStream = startApprovalRun(harness, sessionId, 'history-tool.txt');
  await waitForApproval(harness, sessionId);
  const decision = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decision.statusCode, 200);
  const first = await firstStream;
  assert.equal(first.statusCode, 200);
  const firstDone = await readDoneResponse(harness, sessionId, first);
  assert.equal(firstDone.session.modelPresetId, originalModelPreset.id);

  const second = await requestSse(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      content: 'follow up using that result',
      repoRoot: process.cwd(),
      approval: 'off',
      operationId: OPERATION_B,
      maxTurns: 2,
      mockResponses: repoAgentFinishResponses('second repo-agent result'),
      mockCommandResults: {},
    }),
  });
  assert.equal(second.statusCode, 200);

  const followUp = engineService.requests.find((request) => request.prompt === 'follow up using that result');
  assert.ok(followUp);
  assert.equal(followUp.presetId, 'repo-agent');
  assert.ok(followUp.history);
  assert.equal(findPlannerContextViolation(followUp.history), null);
  assert.equal(followUp.history.filter(message => message.role === 'tool').length, 1);
  assert.equal(followUp.history.at(-1)?.content, 'wrote it');
  const nativeCall = followUp.history.flatMap(message => message.tool_calls ?? [])[0];
  assert.equal(nativeCall?.function.arguments, JSON.stringify({ path: 'history-tool.txt', content: 'approved' }));
  assert.ok(firstDone.session.messages.some(message => message.kind === 'repo_agent_approval' && message.approvalDecision === 'approve'));
  assert.equal(followUp.modelPresetId, firstDone.session.modelPresetId);
  assert.deepEqual(followUp.modelPreset, originalModelPreset);
  assert.ok(followUp.config);
  const requestModelPreset = getActiveModelPreset(followUp.config);
  const { id: requestPresetId, ...requestModelFields } = requestModelPreset;
  const { id: sessionPresetId, ...sessionModelFields } = originalModelPreset;
  assert.equal(requestPresetId, replacementModelPreset.id);
  assert.equal(sessionPresetId, firstDone.session.modelPresetId);
  assert.deepEqual(requestModelFields, sessionModelFields);
});

test('chat repo-agent decide rejects a run that is generating instead of parked', async (t) => {
  const engineGate = new EngineGate();
  const harness = await startHarness('siftkit-chat-repo-agent-running-', t, {
    engineService: new GatedEngineService(engineGate),
  });
  const sessionId = await createSession(harness, 'Running run');
  t.after(() => {
    engineGate.release();
  });

  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'hold generation',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('released'),
        mockCommandResults: {},
      }),
    },
  );
  await waitForRunStatus(harness, sessionId, 'running');
  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 409);
  engineGate.release();
  await readDoneResponse(harness, sessionId, await stream);
});

test('chat repo-agent persists deny reasons and abort outcomes', async (t) => {
  for (const scenario of [
    { decision: 'deny', reason: 'wrong file', expected: 'wrote it' },
    { decision: 'abort', reason: null, expected: 'Repo-agent run stopped by user.' },
  ] as const) {
    const harness = await startHarness(`siftkit-chat-repo-agent-${scenario.decision}-`, t);
    const sessionId = await createSession(harness, `${scenario.decision} run`);
    const stream = startApprovalRun(harness, sessionId, `${scenario.decision}.txt`);
    await waitForApproval(harness, sessionId);
    const payload = scenario.decision === 'deny'
      ? { decision: scenario.decision, reason: scenario.reason }
      : { decision: scenario.decision };
    const decide = await requestJson(
      `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    assert.equal(decide.statusCode, 200);
    const completed = await readDoneResponse(harness, sessionId, await stream);
    const messages = completed.session.messages;
    const approval = messages.find(message => message.kind === 'repo_agent_approval');
    assert.equal(approval?.kind, 'repo_agent_approval');
    if (approval?.kind === 'repo_agent_approval') {
      assert.equal(approval.approvalDecision, scenario.decision);
      assert.equal(approval.approvalReason, scenario.reason);
    }
    if (scenario.decision === 'abort') assert.equal(messages.at(-1)?.runTerminalCause, 'user_stop');
    else assert.equal(messages.at(-1)?.content, scenario.expected);
    await harness.close();
  }
});

test('chat repo-agent streams thinking deltas', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-thinking-', t);
  const sessionId = await createSession(harness, 'Thinking run');
  const response = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'inspect the cipher',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: cipherThinkingMockResponses(),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 200);
  const thinkingFrames = readChatStreamViews(response, sessionId).flatMap(view => view.snapshot.messages.filter(message => message.kind === 'assistant_thinking'));
  assert.ok(
    thinkingFrames.length >= 1,
    `expected at least one thinking frame, got events: ${JSON.stringify(response.events.map((event) => event.event))}`,
  );
  const assembled = thinkingFrames.map(message => message.content).join('\n');
  assert.ok(
    assembled.includes('inspecting the cipher'),
    `reassembled thinking text must contain the mock thinking, got: ${assembled}`,
  );
  assert.ok(
    readChatStreamViews(response, sessionId).some(view => view.snapshot.tools.length > 0),
    `tool_start frames must still arrive, got events: ${JSON.stringify(response.events.map((event) => event.event))}`,
  );
  await readDoneResponse(harness, sessionId, response);
});

test('chat repo-agent persists its thinking trace', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-persist-trace-', t);
  const sessionId = await createSession(harness, 'Persisted trace run');
  const response = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'inspect the cipher',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: cipherThinkingMockResponses(),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 200);
  const completed = await readDoneResponse(harness, sessionId, response);
  const messages = completed.session.messages;
  const answerIndex = messages.findIndex((message) => message.kind === 'assistant_answer');
  assert.ok(answerIndex >= 0, 'expected an assistant_answer row in the persisted transcript');
  const beforeAnswer = messages.slice(0, answerIndex);
  const thinkingRows = beforeAnswer.filter((message) => message.kind === 'assistant_thinking');
  assert.ok(
    thinkingRows.some((message) => message.content.includes('inspecting the cipher')),
    `expected an assistant_thinking row containing the mock thinking before the answer, got: ${JSON.stringify(thinkingRows.map((message) => message.content))}`,
  );
  assert.ok(
    beforeAnswer.some((message) => message.kind === 'assistant_tool_call'),
    `expected at least one assistant_tool_call row before the answer, got: ${JSON.stringify(beforeAnswer.map((message) => message.kind))}`,
  );
});

test('repo-agent operation stream omits thinking', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-op-livtext-', t);
  const response = await requestOperationSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'inspect the cipher',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 4,
      approval: 'auto',
      availableModels: ['mock-model'],
      mockResponses: cipherThinkingMockResponses(),
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  assert.ok(response.result, response.rawBody);
  const result = RepoAgentRunResultSchema.parse(response.result);
  assert.equal(result.status, 'completed');
  const liveTextFrames = response.progress.filter((event) =>
    event.kind === 'thinking' || event.kind === 'narration' || event.kind === 'progress_update');
  assert.equal(
    liveTextFrames.length,
    0,
    `operation stream must not forward live-text frames, got: ${JSON.stringify(liveTextFrames)}`,
  );
});

test('chat repo-agent stream rejects a request without an approval mode', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-no-mode-', t);
  const sessionId = await createSession(harness, 'No mode');
  const response = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: 'write a file', repoRoot: process.cwd(), operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('never'), mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'approval must be one of: interactive, auto, off.');
});

test('approval-mode endpoint rejects sessions without an active run and invalid modes', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-mode-409-', t);
  const sessionId = await createSession(harness, 'Mode without run');
  const idle = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'off' }) },
  );
  assert.equal(idle.statusCode, 409);
  const invalid = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'manual' }) },
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, 'approval must be one of: interactive, auto, off.');
});

test('switching a parked chat run to off approves the pending command and skips later approvals', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-switch-off-', t);
  const sessionId = await createSession(harness, 'Switch to off');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write two files',
        repoRoot: process.cwd(),
        approval: 'interactive',
        operationId: OPERATION_A,
        maxTurns: 6,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: 'first.txt', content: 'one' } }] },
          { toolCalls: [{ name: 'write', arguments: { path: 'second.txt', content: 'two' } }] },
          ...repoAgentFinishResponses('wrote both'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  const active = await waitForApproval(harness, sessionId);
  const parsedActive = ActiveChatRepoAgentResponseSchema.parse(active);
  assert.equal(parsedActive.approvalMode, 'interactive');
  assert.equal(parsedActive.status, 'approval_required');
  const parkedApprovalId = parsedActive.status === 'approval_required' ? parsedActive.approval.approvalId : null;

  const switched = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'off' }) },
  );
  assert.equal(switched.statusCode, 200);
  const switchedBody = ChatRepoAgentApprovalModeResponseSchema.parse(switched.body);
  assert.equal(switchedBody.approval, 'off');
  assert.equal(switchedBody.released?.approvalId, parkedApprovalId);
  assert.match(String(switchedBody.released?.decidedAtUtc), /^\d{4}-\d{2}-\d{2}T/u);

  const response = await stream;
  assert.equal(response.statusCode, 200);
  // Exactly one approval frame: the second write ran under `off` without parking.
  assert.equal(new Set(readChatStreamViews(response, sessionId).flatMap(view => view.snapshot.approval ? [view.snapshot.approval.approvalId] : [])).size, 1);
  const completed = await readDoneResponse(harness, sessionId, response);
  const approvals = completed.session.messages.filter((message) => message.kind === 'repo_agent_approval');
  assert.equal(approvals.length, 1);
  const approval = approvals[0];
  assert.equal(approval?.kind === 'repo_agent_approval' ? approval.approvalDecision : null, 'approve');
  assert.equal(completed.session.messages.at(-1)?.content.includes('wrote both'), true);
});

test('active endpoint reports the live mode and a running chat run switches modes without parking', async (t) => {
  const gate = new EngineGate();
  const harness = await startHarness('siftkit-chat-repo-agent-mode-running-', t, {
    engineService: new GatedEngineService(gate),
  });
  const sessionId = await createSession(harness, 'Mode while running');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'hold generation', repoRoot: process.cwd(), approval: 'auto', operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('held then done'), mockCommandResults: {},
      }),
    },
  );
  await waitForRunStatus(harness, sessionId, 'running');
  const before = ActiveChatRepoAgentResponseSchema.parse(
    (await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`)).body,
  );
  assert.equal(before.approvalMode, 'auto');
  const switched = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'interactive' }) },
  );
  assert.equal(switched.statusCode, 200);
  assert.equal(ChatRepoAgentApprovalModeResponseSchema.parse(switched.body).released, null);
  const after = ActiveChatRepoAgentResponseSchema.parse(
    (await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`)).body,
  );
  assert.equal(after.approvalMode, 'interactive');
  gate.release();
  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal((await readDoneResponse(harness, sessionId, response)).session.messages.filter((m) => m.kind === 'repo_agent_approval').length, 0);
});

test('an auto-mode chat run whose reviewer is unsure surfaces an approval frame instead of ending the stream', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-auto-unsure-', t);
  const sessionId = await createSession(harness, 'Auto unsure');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write a file',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: 'unsure.txt', content: 'x' } }] },
          { content: '{"verdict":"unsure","reason":"cannot judge"}' },
          ...repoAgentFinishResponses('escalated and approved'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  const active = ActiveChatRepoAgentResponseSchema.parse(await waitForApproval(harness, sessionId));
  assert.equal(active.status, 'approval_required');
  assert.equal(active.approvalMode, 'auto');
  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal(readChatStreamViews(response, sessionId).some(view => view.snapshot.approval !== null), true);
  assert.equal(readChatStream(response, sessionId).failure, null);
  assert.equal((await readDoneResponse(harness, sessionId, response)).session.messages.at(-1)?.content.includes('escalated and approved'), true);
});

test('deciding an approval broadcasts an approval_resolved frame to attached readers', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-resolved-', t);
  const sessionId = await createSession(harness, 'Resolved');
  const run = startApprovalRun(harness, sessionId, 'resolved.txt');
  await waitForApproval(harness, sessionId);
  const attached = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`,
    { method: 'GET', timeoutMs: 20_000 },
  );
  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  await run;
  const frames = await attached;
  const views = readChatStreamViews(frames, sessionId);
  const resolved = views.at(-1)?.snapshot.approval;
  assert.ok(resolved);
  assert.equal(resolved.outcome, 'approved');
  assert.equal(resolved.actionable, false);
  assert.equal(readChatStream(frames, sessionId).terminal?.terminalCause, 'completed');
  assert.equal(views.at(-1)?.snapshot.messages.filter(message => message.kind === 'repo_agent_approval').length, 1);
});

const READ_SENTINEL = 'sentinel-after-character-200';
const HOLD_COMMAND = buildRepoToolRequestedCommand('run', { command: 'hold-until-stopped' });

function writeSentinelDocument(): string {
  const filler = Array.from({ length: 24 }, (_, index) => `filler line ${index + 1} of the document`);
  const text = `${filler.join('\n')}\n${READ_SENTINEL}\ntrailing line\n`;
  fs.writeFileSync(path.join(process.cwd(), 'doc.txt'), text, 'utf8');
  return text;
}

function readToolRows(messages: readonly { kind: string }[]): JsonObject[] {
  return messages.filter((message): message is JsonObject & { kind: string } => (
    message.kind === 'assistant_tool_call'
  ));
}

test('a stopped repo-agent turn persists and replays the whole tool result, not its preview', async (t) => {
  const engineService = new HoldingCaptureEngineService(HOLD_COMMAND);
  const harness = await startHarness('siftkit-chat-repo-agent-full-result-', t, { engineService });
  const sessionId = await createSession(harness, 'Full evidence');
  writeSentinelDocument();

  const stopped = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'read the document',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_A,
        mockResponses: [
          { toolCalls: [{ name: 'read', arguments: { path: 'doc.txt' } }] },
          { toolCalls: [{ name: 'run', arguments: { command: 'hold-until-stopped' } }] },
          ...repoAgentFinishResponses('unreachable'),
        ],
        mockCommandResults: {
          [HOLD_COMMAND]: { exitCode: 0, stdout: 'never observed', stderr: '', delayMs: 30_000 },
        },
      }),
    },
  );
  await engineService.waitUntilHoldingTool();
  const stopResponse = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`,
    { method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }) },
  );
  assert.equal(stopResponse.statusCode, 200);

  const persistedSession = (await readDoneResponse(harness, sessionId, await stopped)).session;
  const toolRows = readToolRows(persistedSession.messages);
  assert.deepEqual(toolRows.map((row) => row.toolCallStatus), ['done', 'stopped']);
  const completedRow = toolRows[0];
  assert.ok(completedRow);
  const fullOutput = completedRow.toolCallOutput;
  assert.equal(typeof fullOutput, 'string');
  assert.equal(String(fullOutput).includes(READ_SENTINEL), true);
  assert.equal(String(fullOutput).length > 203, true);
  // The browser preview stays a preview; it is stored beside the evidence, never instead of it.
  assert.equal(String(completedRow.toolCallOutputSnippet).length <= 203, true);
  assert.notEqual(completedRow.toolCallOutputSnippet, fullOutput);

  await harness.restart();

  const continued = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'continue',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_B,
        mockResponses: repoAgentFinishResponses('continued'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(continued.statusCode, 200);
  const continuation = getCapturedRepoAgentRequest(engineService, 'continue');
  const replayedToolMessages = (continuation.history ?? []).filter((message) => message.role === 'tool');
  // Preserve the real result and close the unanswered call with explicit uncertainty.
  assert.equal(replayedToolMessages.length, 2);
  assert.equal(replayedToolMessages[0]?.content, fullOutput);
  assert.equal(String(replayedToolMessages[0]?.content).includes(READ_SENTINEL), true);
  assert.match(String(replayedToolMessages[1]?.content), /Outcome uncertain/iu);
  assert.equal(String(replayedToolMessages[1]?.content).includes('never observed'), false);
});

test('a completed repo-agent turn persists every tool result in full and replays them exactly', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-repo-agent-completed-full-', t, { engineService });
  const sessionId = await createSession(harness, 'Completed evidence');
  writeSentinelDocument();

  const completed = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'read both files',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_A,
        mockResponses: [
          {
            toolCalls: [
              { name: 'read', arguments: { path: 'doc.txt' } },
              { name: 'read', arguments: { path: 'package.json' } },
            ],
          },
          ...repoAgentFinishResponses('read both files'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  const toolRows = readToolRows((await readDoneResponse(harness, sessionId, completed)).session.messages);
  assert.equal(toolRows.length, 2);
  assert.deepEqual(toolRows.map((row) => row.toolCallStatus), ['done', 'done']);
  assert.equal(new Set(toolRows.map((row) => row.id)).size, 2);
  const sentinelRow = toolRows[0];
  assert.ok(sentinelRow);
  assert.equal(String(sentinelRow.toolCallOutput).includes(READ_SENTINEL), true);
  assert.equal(String(sentinelRow.toolCallOutputSnippet).length <= 203, true);

  const followUp = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'summarise',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_B,
        mockResponses: repoAgentFinishResponses('summarised'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(followUp.statusCode, 200);
  const replayed = (getCapturedRepoAgentRequest(engineService, 'summarise').history ?? [])
    .filter((message) => message.role === 'tool');
  assert.equal(replayed.length, 2);
  assert.deepEqual(
    replayed.map((message) => message.content),
    toolRows.map((row) => row.toolCallOutput),
  );
});

test('stopping at an approval keeps the finished read whole and records the parked tool as never started', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-repo-agent-approval-stop-', t, { engineService });
  const sessionId = await createSession(harness, 'Approval stop');
  writeSentinelDocument();

  const stopped = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'read then write',
        repoRoot: process.cwd(),
        approval: 'interactive',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: [
          { toolCalls: [{ name: 'read', arguments: { path: 'doc.txt' } }] },
          { toolCalls: [{ name: 'write', arguments: { path: 'out.txt', content: 'no' } }] },
          ...repoAgentFinishResponses('unreachable'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  await waitForApproval(harness, sessionId);
  const stopResponse = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`,
    { method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }) },
  );
  assert.equal(stopResponse.statusCode, 200);

  const toolRows = readToolRows((await readDoneResponse(harness, sessionId, await stopped)).session.messages);
  assert.deepEqual(toolRows.map((row) => row.toolCallStatus), ['done', 'stopped']);
  assert.equal(toolRows[1]?.toolCallExecutionState, 'not_started');
  assert.equal(toolRows[1]?.toolCallOutput, null);
  assert.equal(String(toolRows[0]?.toolCallOutput).includes(READ_SENTINEL), true);

  const continued = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'carry on',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_B,
        mockResponses: repoAgentFinishResponses('carried on'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(continued.statusCode, 200);
  const replayed = (getCapturedRepoAgentRequest(engineService, 'carry on').history ?? [])
    .filter((message) => message.role === 'tool');
  assert.equal(replayed.length, 2);
  assert.equal(String(replayed[0]?.content).includes(READ_SENTINEL), true);
  assert.match(String(replayed[1]?.content), /never started/iu);
});

test('a continuation cannot start until the stopped turn is durably saved', async (t) => {
  const engineService = new HoldingCaptureEngineService(HOLD_COMMAND, true);
  const harness = await startHarness('siftkit-chat-repo-agent-persist-gate-', t, { engineService });
  const sessionId = await createSession(harness, 'Persistence gate');
  writeSentinelDocument();

  const stopped = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'read then hold',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_A,
        mockResponses: [
          { toolCalls: [{ name: 'read', arguments: { path: 'doc.txt' } }] },
          { toolCalls: [{ name: 'run', arguments: { command: 'hold-until-stopped' } }] },
          ...repoAgentFinishResponses('unreachable'),
        ],
        mockCommandResults: {
          [HOLD_COMMAND]: { exitCode: 0, stdout: 'never observed', stderr: '', delayMs: 30_000 },
        },
      }),
    },
  );
  await engineService.waitUntilHoldingTool();
  const stopRequest = requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/stop`,
    { method: 'POST', body: JSON.stringify({ operationId: OPERATION_A }) },
  );
  await engineService.waitUntilUnwound();

  const early = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: 'too early',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_B,
        mockResponses: repoAgentFinishResponses('too early'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(early.statusCode, 409);
  assert.equal(engineService.requests.some((entry) => entry.prompt === 'too early'), false);

  engineService.releaseAfterAbort();
  assert.equal((await stopRequest).statusCode, 200);
  const toolRows = readToolRows((await readDoneResponse(harness, sessionId, await stopped)).session.messages);
  assert.equal(String(toolRows[0]?.toolCallOutput).includes(READ_SENTINEL), true);

  const continued = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'now continue',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_B,
        mockResponses: repoAgentFinishResponses('continued'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(continued.statusCode, 200);
});

async function runReadTurn(
  harness: StreamedOperationHarness,
  sessionId: string,
  content: string,
  operationId: string,
): Promise<SseResponse> {
  return await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content,
        repoRoot: process.cwd(),
        approval: 'off',
        operationId,
        mockResponses: [
          { toolCalls: [{ name: 'read', arguments: { path: 'doc.txt' } }] },
          ...repoAgentFinishResponses(`${content} done`),
        ],
        mockCommandResults: {},
      }),
    },
  );
}

test('a continuation survives artifact cleanup while the archived transcript remains', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-repo-agent-archive-', t, { engineService });
  const sessionId = await createSession(harness, 'Archive fallback');
  writeSentinelDocument();
  const first = await runReadTurn(harness, sessionId, 'read the document', OPERATION_A);
  assert.equal(first.statusCode, 200);
  await awaitRepoSearchRunPersistence();

  const database = getRuntimeDatabase(getRuntimeDatabasePath());
  const swept = database.prepare(
    "DELETE FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript'",
  ).run();
  assert.equal(Number(swept.changes) > 0, true);

  const continued = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'continue from the archive',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_B,
        mockResponses: repoAgentFinishResponses('continued'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(continued.statusCode, 200);
  const replayed = (getCapturedRepoAgentRequest(engineService, 'continue from the archive').history ?? [])
    .filter((message) => message.role === 'tool');
  assert.equal(replayed.length, 1);
  assert.equal(String(replayed[0]?.content).includes(READ_SENTINEL), true);
});

test('corrupt canonical journal evidence blocks continuation while its display prefix remains readable', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-repo-agent-no-source-', t, { engineService });
  const sessionId = await createSession(harness, 'No source');
  writeSentinelDocument();
  const first = await runReadTurn(harness, sessionId, 'read the document', OPERATION_A);
  assert.equal(first.statusCode, 200);
  await awaitRepoSearchRunPersistence();

  const database = getRuntimeDatabase(getRuntimeDatabasePath());
  const sourceRunId = readToolRows((await readDoneResponse(harness, sessionId, first)).session.messages)[0]?.sourceRunId;
  assert.equal(typeof sourceRunId, 'string');
  database.prepare('UPDATE chat_messages SET tool_call_output = tool_call_output_snippet WHERE session_id = ?').run(sessionId);
  database.prepare("UPDATE chat_run_events SET payload_digest='corrupt' WHERE operation_id=? AND kind='tool_result'").run(sourceRunId);
  database.prepare("DELETE FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript'").run();
  database.prepare('UPDATE run_logs SET repo_search_transcript_jsonl = NULL').run();

  const blocked = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: 'continue without evidence',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_B,
        mockResponses: repoAgentFinishResponses('unreachable'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(blocked.statusCode, 409);
  assert.equal(String(blocked.body.error).includes(String(sourceRunId)), true);
  assert.equal(engineService.requests.some((entry) => entry.prompt === 'continue without evidence'), false);
  assert.equal(new ChatJournalStore(database).listSessionRuns(sessionId).length, 1, 'blocked continuation must not create another accepted run');

  // The chat itself stays readable; only the continuation is refused.
  const session = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(session.statusCode, 200);
});

test('the first continuation uses repaired historical evidence rather than the pre-repair session', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-repair-first-replay-', t, { engineService });
  const sessionId = await createSession(harness, 'Historical evidence');
  writeSentinelDocument();
  const first = await runReadTurn(harness, sessionId, 'original read', OPERATION_A);
  const tool = readToolRows((await readDoneResponse(harness, sessionId, first)).session.messages)[0];
  assert.ok(tool);
  const originalOutput = tool.toolCallOutput;
  const database = getRuntimeDatabase();
  // Reproduce a display projection damaged to its preview; the journal remains the authority.
  database.prepare('UPDATE chat_messages SET tool_call_output = tool_call_output_snippet WHERE session_id = ?').run(sessionId);
  const continued = await runReadTurn(harness, sessionId, 'first repaired continuation', OPERATION_B);
  assert.equal(continued.statusCode, 200);
  const replay = getCapturedRepoAgentRequest(engineService, 'first repaired continuation').history ?? [];
  assert.equal(replay.find((message) => message.role === 'tool')?.content, originalOutput);
});

test('verified chat evidence survives removal of every run transcript and a restart', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-verified-no-archive-', t, { engineService });
  const sessionId = await createSession(harness, 'Verified evidence');
  writeSentinelDocument();
  const first = await runReadTurn(harness, sessionId, 'verified read', OPERATION_A);
  const tool = readToolRows((await readDoneResponse(harness, sessionId, first)).session.messages)[0];
  assert.ok(tool);
  await awaitRepoSearchRunPersistence();
  const database = getRuntimeDatabase();
  database.prepare("DELETE FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript'").run();
  database.prepare('UPDATE run_logs SET repo_search_transcript_jsonl = NULL').run();
  await harness.restart();
  const continued = await runReadTurn(harness, sessionId, 'continue verified history', OPERATION_B);
  assert.equal(continued.statusCode, 200);
  const replay = getCapturedRepoAgentRequest(engineService, 'continue verified history').history ?? [];
  assert.equal(replay.find((message) => message.role === 'tool')?.content, tool.toolCallOutput);
});

class FailAfterReadProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(private readonly inner: ProgressWriter<RepoSearchProgressEvent>) { super(); }
  get enabled(): boolean { return this.inner.enabled; }
  override get wantsLiveText(): boolean { return this.inner.wantsLiveText; }
  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'llm_start' && event.turn === 2) throw new Error('Provider failed after completed read');
    this.inner.write(event);
  }
}

test('a missing display result is rebuilt from the journal before continuation', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-missing-full-result-', t, { engineService });
  const sessionId = await createSession(harness, 'Missing full result');
  writeSentinelDocument();
  const first = await runReadTurn(harness, sessionId, 'read before corruption', OPERATION_A);
  const original = readToolRows((await readDoneResponse(harness, sessionId, first)).session.messages)[0];
  assert.ok(original);
  getRuntimeDatabase().prepare('UPDATE chat_messages SET tool_call_output = NULL WHERE session_id = ?').run(sessionId);
  const response = await runReadTurn(harness, sessionId, 'do not replay preview', OPERATION_B);
  assert.equal(response.statusCode, 200);
  const history = engineService.requireRequest('do not replay preview').history ?? [];
  assert.equal(history.find(message => message.role === 'tool')?.content, original.toolCallOutput);
  assert.equal(readToolRows((await readDoneResponse(harness, sessionId, response)).session.messages)[0]?.toolCallOutput, original.toolCallOutput);
});

class FailAfterReadEngineService extends StatusEngineService {
  readonly requests: RepoSearchExecutionRequest[] = [];
  override async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    this.requests.push(request);
    const writer = request.progressWriter;
    return await super.executeRepoSearch(request.prompt === 'fail after read' && writer
      ? { ...request, progressWriter: new FailAfterReadProgressWriter(writer) }
      : request);
  }
}

test('a provider failure preserves completed tools and replays them on continuation', async (t) => {
  const engineService = new FailAfterReadEngineService();
  const harness = await startHarness('siftkit-chat-failed-tool-evidence-', t, { engineService });
  const sessionId = await createSession(harness, 'Failed evidence');
  writeSentinelDocument();
  const failed = await runReadTurn(harness, sessionId, 'fail after read', OPERATION_A);
  assert.match(readChatStream(failed, sessionId).failure?.error ?? '', /Provider failed after completed read/u);
  const saved = ChatSessionResponseSchema.parse((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`)).body).session;
  const rows = readToolRows(saved.messages);
  assert.equal(rows.length, 1, 'a completed read must survive a provider failure');
  assert.equal(String(rows[0]?.toolCallOutput).includes(READ_SENTINEL), true);
  assert.equal(saved.messages.at(-1)?.runTerminalCause, 'execution_failure');
  assert.match(saved.messages.at(-1)?.runTerminalDetail ?? '', /Provider failed after completed read/u);
  assert.equal(saved.messages.some((message) => message.content.includes('stopped by user')), false);
  const continued = await runReadTurn(harness, sessionId, 'continue failed history', OPERATION_B);
  assert.equal(continued.statusCode, 200);
  const replay = engineService.requests.find((request) => request.prompt === 'continue failed history')?.history ?? [];
  assert.equal(replay.find((message) => message.role === 'tool')?.content, rows[0]?.toolCallOutput);
});

function countConsoleLines(capture: OutputCapture, event: string, needle: string): number {
  const withoutColour = capture.lines.map((line) => line.replace(/\[[0-9;]*m/gu, ''));
  return withoutColour.filter((line) => line.includes(`  ${event}`) && line.includes(needle)).length;
}

test('each repo-agent tool invocation prints exactly one command line, whoever is watching', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-repo-agent-log-once-', t, { engineService });
  const sessionId = await createSession(harness, 'Log cardinality');
  writeSentinelDocument();
  const capture = OutputCapture.start(process.stdout);
  t.after(() => capture.restore());

  const attached = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`,
    { method: 'GET', timeoutMs: 20_000 },
  );
  const first = await runReadTurn(harness, sessionId, 'read once', OPERATION_A);
  assert.equal(first.statusCode, 200);
  await attached;

  // One stable tool identity reaches the client; only its actual start reaches the console.
  const views = readChatStreamViews(first, sessionId);
  assert.equal(new Set(views.flatMap(view => view.snapshot.tools.map(tool => tool.toolCallId))).size, 1);
  assert.equal(views.at(-1)?.snapshot.tools.filter(tool => tool.executionState === 'completed').length, 1);
  assert.equal(countConsoleLines(capture, 'command', 'read path="doc.txt"'), 1);

  // A second browser reader must not double the console, and a genuine repeat must still print.
  const second = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`,
    { method: 'GET', timeoutMs: 20_000 },
  );
  const repeat = await runReadTurn(harness, sessionId, 'read again', OPERATION_B);
  assert.equal(repeat.statusCode, 200);
  await second;
  assert.equal(countConsoleLines(capture, 'command', 'read path="doc.txt"'), 2);
});

test('an automatic approval prints one approval line for the run that made it', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-approval-log-', t);
  const sessionId = await createSession(harness, 'Approval log');
  const capture = OutputCapture.start(process.stdout);
  t.after(() => capture.restore());

  const response = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write a note',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: cipherThinkingMockResponses(),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(countConsoleLines(capture, 'auto-approval', 'approve'), 1);
});

test('a mixed session switches to repo-agent after unrelated run-log cleanup, while unresolved repo-agent history stays blocked', async (t) => {
  const engineService = new HoldingCaptureEngineService('never-matched');
  const harness = await startHarness('siftkit-chat-mixed-provenance-', t, { engineService });
  const sessionId = await createSession(harness, 'Mixed provenance');
  writeSentinelDocument();

  // A repo-search turn reads the document: a completed tool row whose source run is not repo-agent.
  const searched = await requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'search the document',
        repoRoot: process.cwd(),
        operationId: OPERATION_A,
        maxTurns: 2,
        mockResponses: [
          { toolCalls: [{ name: 'read', arguments: { path: 'doc.txt' } }] },
          { content: 'searched' },
        ],
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(searched.statusCode, 200);
  const searchRow = readToolRows((await readDoneResponse(harness, sessionId, searched)).session.messages)[0];
  assert.ok(searchRow);
  const searchRunId = engineService.requireRequest('search the document').requestId;
  assert.equal(typeof searchRunId, 'string');
  await awaitRepoSearchRunPersistence();

  // Its archives disappear; its identity survives. That must not hold the session hostage.
  const database = getRuntimeDatabase(getRuntimeDatabasePath());
  database.prepare("DELETE FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript' AND request_id = ?").run(searchRunId);
  database.prepare('UPDATE run_logs SET repo_search_transcript_jsonl = NULL WHERE request_id = ?').run(searchRunId);

  const agent = await runReadTurn(harness, sessionId, 'now use the agent', OPERATION_B);
  assert.equal(agent.statusCode, 200);
  const agentReplay = (engineService.requireRequest('now use the agent').history ?? []).filter((message) => message.role === 'tool');
  assert.equal(agentReplay.length, 1);
  assert.equal(agentReplay[0]?.content, searchRow.toolCallOutput);
  const agentRow = readToolRows((await readDoneResponse(harness, sessionId, agent)).session.messages)[1];
  assert.ok(agentRow);
  const agentRunId = engineService.requireRequest('now use the agent').requestId;
  await awaitRepoSearchRunPersistence();

  // Corrupt this run's authoritative evidence; the unrelated search remains valid.
  database.prepare('UPDATE chat_messages SET tool_call_output = tool_call_output_snippet WHERE session_id = ? AND id = ?').run(sessionId, agentRow.id);
  database.prepare("UPDATE chat_run_events SET payload_digest='corrupt' WHERE operation_id=? AND kind='tool_result'").run(agentRow.sourceRunId);
  database.prepare("DELETE FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript' AND request_id = ?").run(agentRunId);
  database.prepare('UPDATE run_logs SET repo_search_transcript_jsonl = NULL WHERE request_id = ?').run(agentRunId);
  const blocked = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: 'blocked continuation',
        repoRoot: process.cwd(),
        approval: 'off',
        operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('unreachable'),
        mockCommandResults: {},
      }),
    },
  );
  assert.equal(blocked.statusCode, 409);
  assert.equal(String(blocked.body.error).includes(String(agentRow.sourceRunId)), true);
  assert.equal(String(blocked.body.error).includes(String(searchRunId)), false);
  assert.equal(engineService.requests.some((entry) => entry.prompt === 'blocked continuation'), false);
});

const LS_CALL = { name: 'ls', arguments: { path: '.' } } as const;

function followUpHistory(engineService: CapturingEngineService, prompt: string) {
  const request = engineService.requests.find((candidate) => candidate.prompt === prompt);
  assert.ok(request?.history, `Expected a captured follow-up request for ${prompt}.`);
  return request.history;
}

async function runRepoAgentTools(harness: StreamedOperationHarness, sessionId: string, operationId: string,
  toolCalls: readonly (readonly (typeof LS_CALL | { name: 'ls'; arguments: { path: string } })[])[], maxTurns: number): Promise<SseResponse> {
  return await requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({ content: 'list things', repoRoot: process.cwd(), approval: 'off', operationId, maxTurns,
      mockResponses: [...toolCalls.map((calls) => ({ toolCalls: [...calls] })), ...repoAgentFinishResponses('listed')], mockCommandResults: {} }),
  });
}

for (const [label, batches, expectedToolMessages] of [
  ['three repeated ls calls', [[LS_CALL], [LS_CALL], [LS_CALL]], 2],
  ['two repeats then a mixed batch with a fresh call', [[LS_CALL], [LS_CALL], [LS_CALL, { name: 'ls', arguments: { path: 'subdir' } }]], 3],
] as const) test(`${label} collapse deliberately and replay as a completed run`, async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-duplicate-collapse-', t, { engineService });
  fs.mkdirSync(path.join(process.cwd(), 'subdir'), { recursive: true });
  const sessionId = await createSession(harness, label);
  const first = await runRepoAgentTools(harness, sessionId, OPERATION_A, batches, 5);
  assert.equal(first.statusCode, 200);

  const store = new ChatJournalStore(getRuntimeDatabase(getRuntimeDatabasePath()));
  const run = store.listSessionRuns(sessionId).find((candidate) => candidate.recordKind === 'execution');
  assert.equal(run?.terminalCause, 'completed');
  assert.ok(run);
  const events = [...store.readAll(run.operationId)];
  assert.equal(events.filter((envelope) => envelope.event.kind === 'tool_started').length, expectedToolMessages - 1, 'only distinct calls execute');
  const coalescing = events.flatMap((envelope) => envelope.event.kind === 'context_spliced' ? envelope.event.coalescedToolCallIds : []);
  assert.equal(coalescing.length, 1, 'the third repeat is represented by replacing the second');
  const replay = replayChatContext(events);
  assert.equal(replay.status, 'ok');
  assert.deepEqual(replay.issues, []);
  assert.equal(findPlannerContextViolation(replay.messages), null);
  assert.equal(replay.messages.filter((message) => message.role === 'tool').length, expectedToolMessages);
  assert.equal(JSON.stringify(replay.messages).includes('[interrupted]'), false);

  const second = await requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({ content: 'continue after collapse', repoRoot: process.cwd(), approval: 'off', operationId: OPERATION_B, maxTurns: 2,
      mockResponses: repoAgentFinishResponses('continued'), mockCommandResults: {} }),
  });
  assert.equal(second.statusCode, 200);
  const history = followUpHistory(engineService, 'continue after collapse');
  assert.equal(findPlannerContextViolation(history), null);
  assert.equal(history.filter((message) => message.role === 'tool').length, expectedToolMessages);
  assert.equal(JSON.stringify(history).includes('interrupted'), false);
  assert.deepEqual(history.filter((message) => message.role === 'tool'), replay.messages.filter((message) => message.role === 'tool'));
});

test('an invalid native call is durably rejected, corrected on the next turn, and never executes or asks approval', async (t) => {
  const engineService = new CapturingEngineService();
  const harness = await startHarness('siftkit-chat-invalid-call-', t, { engineService });
  const sessionId = await createSession(harness, 'Invalid call recovery');
  const response = await requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({ content: 'read something', repoRoot: process.cwd(), approval: 'interactive', operationId: OPERATION_A, maxTurns: 4,
      mockResponses: [
        { toolCalls: [{ name: 'read', arguments: {} }] },
        { toolCalls: [{ name: 'no_such_tool', arguments: { anything: true } }] },
        ...repoAgentFinishResponses('Recovered successfully'),
      ], mockCommandResults: {} }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.events.some((event) => event.event === 'approval'), false);
  const done = await readDoneResponse(harness, sessionId, response);
  assert.equal(done.session.messages.at(-1)?.content, 'Recovered successfully');

  const store = new ChatJournalStore(getRuntimeDatabase(getRuntimeDatabasePath()));
  const run = store.listSessionRuns(sessionId).find((candidate) => candidate.recordKind === 'execution');
  assert.equal(run?.terminalCause, 'completed');
  assert.ok(run);
  const events = [...store.readAll(run.operationId)];
  assert.equal(events.filter((envelope) => envelope.event.kind === 'tool_started').length, 0, 'invalid calls never execute');
  assert.equal(events.filter((envelope) => envelope.event.kind === 'approval_requested').length, 0);
  const rejected = events.flatMap((envelope) => envelope.event.kind === 'tool_result' && envelope.event.executionState === 'rejected' ? [envelope.event] : []);
  assert.equal(rejected.length, 2);
  const proposals = events.flatMap((envelope) => envelope.event.kind === 'tool_proposed' ? [envelope.event] : []);
  assert.deepEqual(proposals.map((proposal) => proposal.toolName), ['read', 'no_such_tool']);
  assert.deepEqual(rejected.map((result) => result.call), proposals.map((proposal) => proposal.call));
  const replay = replayChatContext(events);
  assert.equal(replay.status, 'ok');
  assert.equal(findPlannerContextViolation(replay.messages), null);
  assert.equal(replay.messages.filter((message) => message.role === 'tool').length, 2);
  assert.ok(done.session.messages.filter((message) => message.kind === 'assistant_tool_call').length >= 2);

  const second = await requestSse(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`, {
    method: 'POST', timeoutMs: 20_000,
    body: JSON.stringify({ content: 'continue after invalid', repoRoot: process.cwd(), approval: 'off', operationId: OPERATION_B, maxTurns: 2,
      mockResponses: repoAgentFinishResponses('continued'), mockCommandResults: {} }),
  });
  assert.equal(second.statusCode, 200);
  const history = followUpHistory(engineService, 'continue after invalid');
  assert.equal(findPlannerContextViolation(history), null);
  assert.equal(history.some((message) => message.role === 'tool'), true);
  assert.equal(JSON.stringify(history).includes('interrupted'), false);
});
