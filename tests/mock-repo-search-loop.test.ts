import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { z } from '../src/lib/zod.js';
import { JsonObjectSchema, type JsonObject, type JsonSerializable } from '../src/lib/json-types.js';
import { asObject, asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';

import {
  runTaskLoop,
  buildScorecard,
  type TaskResult,
} from '../src/repo-search/engine.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { buildRepoToolRequestedCommand } from '../src/repo-search/engine/repo-tools.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import { preflightPlannerPromptBudget } from '../src/repo-search/prompt-budget.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { getTokenEstimateCharactersPerToken } from '../src/lib/token-estimate.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { parseLoggedEvent } from './helpers/logged-events.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import { acquireChildPortLease } from './helpers/test-endpoints.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.js';
import { parseJsonValueText } from '../src/lib/json.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-mock-loop-');

// Mock-mode loops read only a few config fields; the rest of SiftConfig is
// irrelevant, so deliberately partial literals are structurally checked against a
// DeepPartial view and cast to SiftConfig here in one place.
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
function mockLoopConfig(config: DeepPartial<SiftConfig>): SiftConfig {
  return mockSiftConfig({
    ...config,
    Inference: {
      Thinking: { Enabled: false, Preserve: false },
      ...config.Inference,
    },
  });
}

/** An endpoint that answers every route with 404, so tokenize preflight falls back to the estimate without retrying. */
async function startNotFoundServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function modelPresetReasoning(reasoning: 'on' | 'off'): DeepPartial<SiftConfig> {
  return {
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{ id: 'default', Reasoning: reasoning, IdleAction: 'unload' }],
      },
    },
  };
}

// buildScorecard reads only the tallying fields of each TaskResult; the rest are
// irrelevant, so partial literals are structurally checked and cast in one place.
const MockTaskResultSchema = z.custom<TaskResult>((value) => typeof value === 'object' && value !== null);
function mockTaskResult(task: DeepPartial<TaskResult>): TaskResult {
  return MockTaskResultSchema.parse(task);
}

// Logged `turn_new_messages` events carry the planner transcript as arbitrary
// JSON. Parse each message to the fields the assertions read so the access is
// typed without indexing the raw JsonData union.
const PlannerLogMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  tool_calls: z
    .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
    .optional(),
});
type PlannerLogMessage = z.infer<typeof PlannerLogMessageSchema>;
function plannerLogMessages(event: JsonObject | undefined): PlannerLogMessage[] {
  const raw = event?.messages;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((message) => PlannerLogMessageSchema.parse(message));
}

function createTempRepoRoot(gitignoreText = '') {
  const root = createManagedTempDir('siftkit-repo-search-ignore-');
  fs.writeFileSync(path.join(root, '.gitignore'), gitignoreText, 'utf8');
  return root;
}

test('runTaskLoop stops on invalid response limit', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-invalid',
      question: 'Any question.',
      signals: ['unused'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 10,
      maxInvalidResponses: 2,
      mockResponses: [{}, {}, { content: 'Synthesized best-effort answer.' }],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'invalid_response_limit');
  assert.equal(result.invalidResponses, 2);
  assert.equal(result.commands.length, 0);
  assert.equal(result.finalOutput, 'Synthesized best-effort answer.');
});

test('runTaskLoop returns invalid native arguments on the failing call before a valid retry', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-invalid-recoverable-tool-replay',
      question: 'Any question.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ id: 'invalid-git', name: 'git', arguments: { operation: 'grep', path: 'src' } }] },
        { toolCalls: [{ id: 'valid-git', name: 'git', arguments: { operation: 'grep', pattern: 'planner', path: 'src' } }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": {
          exitCode: 0,
          stdout: 'src/repo-search/engine.ts: planner anchor',
        },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const turn3NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3);
  const turn2Messages = plannerLogMessages(turn2NewMessages);
  const turn3Messages = plannerLogMessages(turn3NewMessages);
  const invalidAssistant = turn2Messages.find((message) => message.role === 'assistant');
  const invalidToolMessage = turn2Messages.find((message) => message.role === 'tool');
  const validAssistant = turn3Messages.find((message) => message.role === 'assistant');
  const validToolMessage = turn3Messages.find((message) => message.role === 'tool');

  assert.equal(result.reason, 'finish');
  assert.equal(result.invalidResponses, 0);
  assert.equal(String(invalidAssistant?.tool_calls?.[0]?.function?.name || ''), 'git');
  assert.match(String(invalidToolMessage?.content || ''), /invalid.*pattern/iu);
  assert.equal(String(validAssistant?.tool_calls?.[0]?.function?.name || ''), 'git');
  assert.match(String(validToolMessage?.content || ''), /planner anchor/u);
  assert.equal(turn2Messages.filter((message) => message.role === 'user').length, 0);
});

test('runTaskLoop nudges unrecoverable responses without inventing a tool call', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-invalid-fallback-tool-replay',
      question: 'Any question.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        {},
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const turn2Messages = plannerLogMessages(turn2NewMessages);
  const assistantMessage = turn2Messages.find((message) => message.role === 'assistant');
  const toolMessage = turn2Messages.find((message) => message.role === 'tool');
  const userMessages = turn2Messages.filter((message) => message.role === 'user');

  assert.equal(result.reason, 'finish');
  assert.equal(assistantMessage?.tool_calls, undefined);
  assert.equal(toolMessage, undefined);
  assert.equal(userMessages.length, 1);
  assert.match(String(userMessages[0]?.content || ''), /neither content nor tool calls/u);
});

test('runTaskLoop rejects a malformed native dialect call and reprompts once', { timeout: 5000 }, async () => {
  const events: JsonObject[] = [];
  const progressEvents: RepoSearchProgressEvent[] = [];
  const controller = new AbortController();
  let requestCount = 0;
  let firstStreamClosed = false;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }

    requestCount += 1;
    if (requestCount === 1) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.on('close', () => {
        firstStreamClosed = true;
      });
      res.write(
        `data: ${JSON.stringify({
          choices: [{
            delta: {
              content: '<tool_call><function=git><parameter=pattern>planner</parameter>'
                + '}'.repeat(220),
            },
          }],
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: 'done — the fallback parses `<tool_call>` markup from text.' } }],
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const resultPromise = runTaskLoop(
      {
        id: 'task-runaway-streamed-tool-json',
        question: 'Find planner text.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        baseUrl,
        model: 'mock-model',
        config: mockLoopConfig({ Runtime: { LlamaCpp: { BaseUrl: baseUrl } } }),
        maxTurns: 3,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        abortSignal: controller.signal,
        logger: {
          path: 'memory',
          write(event: Record<string, JsonSerializable>) {
            events.push(parseLoggedEvent(event));
          },
        },
        progressWriter: new CollectingProgressWriter(progressEvents),
      }
    );

    const result = await resultPromise;

    const invalidEvent = events.find((event) => event.kind === 'turn_action_invalid');
    const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
    const turn2Messages = plannerLogMessages(turn2NewMessages);
    const assistantMessage = turn2Messages.find((message) => message.role === 'assistant');
    const userMessage = turn2Messages.find((message) => message.role === 'user');

    assert.equal(result.reason, 'finish');
    assert.equal(result.invalidResponses, 1);
    assert.equal(requestCount, 2);
    assert.equal(firstStreamClosed, true);
    assert.equal(assistantMessage?.tool_calls, undefined);
    assert.match(String(userMessage?.content || ''), /malformed tool-call markup/u);
    assert.match(String(invalidEvent?.error || ''), /malformed tool-call markup/u);
    assert.equal(progressEvents.some((event) => event.kind === 'thinking' && event.thinkingText.includes('}'.repeat(220))), false);
  } finally {
    controller.abort(new Error('test cleanup'));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('runTaskLoop truncates oversized rg output to the largest fitting prefix', async () => {
  const events: JsonObject[] = [];
  const totalContextTokens = 20000;
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 3, config: MOCK_LOOP_DEFAULTS.config });
  const baselinePerToolCapTokens = budget.perToolCapTokens(0, 1);
  const oversizedOutput = Array.from(
    { length: 500 },
    (_, index) => `src/example-${index + 1}.ts:${index + 1}: ${'x'.repeat(80)}`
  ).join('\n');
  const result = await runTaskLoop(
    {
      id: 'task-token-guard',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": {
          exitCode: 0,
          stdout: oversizedOutput,
          stderr: '',
        },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvent = events.find((event) => event.kind === 'turn_command_result');
  assert.equal(typeof commandEvent?.insertedResultText, 'string');
  assert.equal(commandEvent?.perToolCapTokens, baselinePerToolCapTokens);
  assert.equal(Number(commandEvent?.resultTokenCount) <= Number(commandEvent?.perToolCapTokens), true);
  assert.doesNotMatch(String(commandEvent?.insertedResultText || ''), /^Error: requested output would consume/u);
  assert.match(String(commandEvent?.insertedResultText || ''), /^src\/example-1\.ts:1:/u);
  assert.match(String(commandEvent?.insertedResultText || ''), /\d+ lines truncated due to per-tool context limit\./u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop advances overlapping read calls to the next unread span', async () => {
  const repoRoot = createTempRepoRoot();
  const targetPath = path.join(repoRoot, 'target.ts');
  fs.writeFileSync(
    targetPath,
    Array.from({ length: 14 }, (_, index) => `line-${index + 1}`).join('\n'),
    'utf8'
  );
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-native-read-unread-span',
      question: 'Read target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":5} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":5} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.match(String(commandEvents[0]?.insertedResultText || ''), /^1: line-1/mu);
  assert.match(String(commandEvents[0]?.insertedResultText || ''), /^5: line-5/mu);
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /^6: line-6/mu);
  assert.doesNotMatch(String(commandEvents[1]?.insertedResultText || ''), /^1: line-1/mu);
});

test('runTaskLoop replays effective read range after native unread expansion', async () => {
  const repoRoot = createTempRepoRoot();
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'big-file.ts'),
    Array.from({ length: 260 }, (_, index) => `line-${index + 1}`).join('\n'),
    'utf8'
  );
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-native-read-effective-replay',
      question: 'Read target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      // 15k response reserve + 10k compaction reserve leaves the 10000 usable prompt
      // tokens this scenario needs for the first read to return all 80 lines.
      totalContextTokens: 35000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"src/big-file.ts","offset":1,"limit":80} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"src/big-file.ts","offset":40,"limit":51} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  const turn3NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3);
  const turn3Messages = plannerLogMessages(turn3NewMessages);
  const assistantMessages = turn3Messages.filter((message) => message.role === 'assistant');
  const replayedAssistantAction = assistantMessages[assistantMessages.length - 1]?.tool_calls?.[0];
  const replayedAssistantArgs = JsonObjectSchema.parse(parseJsonValueText(
    replayedAssistantAction?.function?.arguments ?? '',
  ));

  assert.equal(result.reason, 'finish');
  assert.match(String(commandEvents[1]?.requestedCommand || ''), /offset=40 limit=51/u);
  assert.match(String(commandEvents[1]?.executedCommand || ''), /offset=81 limit=180/u);
  assert.equal(String(replayedAssistantAction?.function?.name || ''), 'read');
  assert.equal(String(replayedAssistantArgs?.path || ''), 'src/big-file.ts');
  assert.equal(Number(replayedAssistantArgs?.offset), 81);
  assert.equal(Number(replayedAssistantArgs?.limit), 180);
});

test('runTaskLoop replays only the returned read range after fitting an oversized read', async () => {
  const repoRoot = createTempRepoRoot();
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'big.ts'),
    Array.from({ length: 900 }, (_, index) => `line-${index + 1} ${'x'.repeat(80)}`).join('\n'),
    'utf8',
  );
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-budget-bounded-read',
      question: 'read file',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['git', 'read']),
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"needle","path":"src"} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"src/big.ts","offset":300,"limit":601} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"needle\"": { exitCode: 0, stdout: 'src/big.ts:300:needle', stderr: '', delayMs: 5 },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 2);
  assert.equal(result.commands[1]?.safe, true);
  assert.match(String(commandEvents[1]?.requestedCommand || ''), /offset=300 limit=601/u);
  assert.match(String(commandEvents[1]?.executedCommand || ''), /offset=300 limit=\d+/u);
  assert.notEqual(String(commandEvents[1]?.requestedCommand || ''), String(commandEvents[1]?.executedCommand || ''));
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /\d+ lines truncated due to per-tool context limit\./u);

  const turn3 = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3);
  const messages = asObjectArray(turn3?.messages);
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const assistant = assistantMessages[assistantMessages.length - 1];
  const toolCalls = asObjectArray(assistant?.tool_calls);
  const fn = asObject(toolCalls[0]?.function);
  const args = asObject(parseJsonValueText(String(fn.arguments || '')));
  assert.equal(String(fn.name || ''), 'read');
  assert.equal(args.offset, 300);
  assert.equal(Number(args.limit) < 601, true);
});

test('runTaskLoop bounds the unread read span at the next returned range', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, 'target.ts'),
    Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n'),
    'utf8'
  );
  const events: JsonObject[] = [];
  await runTaskLoop(
    {
      id: 'task-native-read-next-range-bound',
      question: 'Read target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":11,"limit":5} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":20} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /^1: line-1/mu);
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /^10: line-10/mu);
  assert.doesNotMatch(String(commandEvents[1]?.insertedResultText || ''), /^11: line-11/mu);
});

test('runTaskLoop rejects a read whose whole range was already returned', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-native-read-exhausted',
      question: 'Read target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  // The first read executes and logs a result; the rejected second read never does.
  assert.equal(commandEvents.length, 1);
  assert.equal(result.commandFailures, 1);
  assert.equal(result.passed, true);
  const rejected = result.commands.filter((command) => command.safe === false);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'exhausted read');
  assert.match(String(rejected[0].output), /Lines 1-3 of target\.ts were already returned in this run/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop forces finish after repeated exhausted reads', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const readAction = { toolCalls: [{ name: 'read', arguments: { path: 'target.ts', offset: 1, limit: 3 } }] };
  await runTaskLoop(
    {
      id: 'task-native-read-exhausted-stagnation',
      question: 'Read target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 8,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        readAction,
        readAction,
        readAction,
        readAction,
        readAction,
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const forcedFinish = events.find((event) => event.kind === 'turn_forced_finish_mode_started');
  assert.equal(String(forcedFinish?.trigger), 'exhausted_read');
});

test('runTaskLoop truncates oversized find output with omitted file count', async () => {
  const repoRoot = createTempRepoRoot();
  for (let index = 1; index <= 160; index += 1) {
    fs.writeFileSync(path.join(repoRoot, `file-${String(index).padStart(3, '0')}.ts`), 'export {};\n', 'utf8');
  }
  const events: JsonObject[] = [];
  await runTaskLoop(
    {
      id: 'task-native-list-truncate',
      question: 'List files.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 7000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['find']),
      mockResponses: [
        { toolCalls: [{ name: "find", arguments: {"pattern":"*.ts","path":"."} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvent = events.find((event) => event.kind === 'turn_command_result');
  assert.match(String(commandEvent?.insertedResultText || ''), /^file-001\.ts/mu);
  assert.match(String(commandEvent?.insertedResultText || ''), /\d+ files truncated due to per-tool context limit\./u);
});

test('runTaskLoop records line-read stats for the lines a fitted read actually returned', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, 'big.ts'),
    Array.from({ length: 300 }, (_, index) => `line-${index + 1} ${'x'.repeat(40)}`).join('\n'),
    'utf8',
  );
  const result = await runTaskLoop(
    {
      id: 'task-oversized-line-read-stats',
      question: 'Read a large file section.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"big.ts","offset":1,"limit":300} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
    }
  );

  // The read asked for 300 lines but per-tool fitting truncated it; stats must count
  // only the lines the model actually saw, so the read-overlap ledger stays truthful.
  assert.equal(result.toolStats.read.lineReadCalls, 1);
  assert.equal(Number(result.toolStats.read.lineReadLinesTotal) > 0, true);
  assert.equal(Number(result.toolStats.read.lineReadLinesTotal) < 300, true);
  assert.equal(
    Number(result.readOverlapSummary?.totalLinesRead),
    Number(result.toolStats.read.lineReadLinesTotal),
  );
});

test('runTaskLoop does not print a red console warning when successful output is fitted', async () => {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (typeof callback === 'function') {
      callback();
    } else if (typeof encodingOrCallback === 'function') {
      encodingOrCallback();
    }
    return true;
  };
  try {
    const totalContextTokens = 20000;
    await runTaskLoop(
      {
        id: 'task-token-guard-console-warning',
        question: 'Find planner text.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        totalContextTokens,
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
          { content: "done" },
          { content: '{"verdict":"pass","reason":"supported"}' },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\"src\" pattern=\"planner\"": {
            exitCode: 0,
            stdout: 'x'.repeat(10000),
            stderr: '',
          },
        },
      }
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  const redWarning = writes.find((line) => /\x1b\[31m.*requested output would consume/u.test(line));
  assert.equal(Boolean(redWarning), false);
});

test('preflightPlannerPromptBudget reports overflow against context budget', async () => {
  const preflight = await preflightPlannerPromptBudget({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'x '.repeat(10000) },
    ],
    includeReasoningContent: false,
    totalContextTokens: 7000,
    responseReserveTokens: 4000,
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.maxPromptBudget, 3000);
  assert.equal(preflight.promptTokenCount > preflight.maxPromptBudget, true);
  assert.equal(preflight.overflowTokens > 0, true);
});

test('preflightPlannerPromptBudget reserves provider prompt overhead against context budget', async () => {
  const withoutReserve = await preflightPlannerPromptBudget({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'short request' },
    ],
    includeReasoningContent: false,
    totalContextTokens: 4200,
    responseReserveTokens: 4000,
  });
  const withReserve = await preflightPlannerPromptBudget({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'short request' },
    ],
    includeReasoningContent: false,
    providerPromptReserveText: 'provider tools and response schema '.repeat(900),
    totalContextTokens: 4200,
    responseReserveTokens: 4000,
  });

  assert.equal(withoutReserve.ok, true);
  assert.equal(withReserve.ok, false);
  assert.equal(withReserve.providerPromptReserveTokenCount > 0, true);
  assert.equal(withReserve.promptTokenCount > withoutReserve.promptTokenCount, true);
  assert.equal(withReserve.promptTokenCount > withReserve.maxPromptBudget, true);
});

test('runTaskLoop fails before any provider request when the summarization prompt cannot fit', async () => {
  const events: JsonObject[] = [];
  // This loop has no mockResponses, so preflight tokenizes for real: point it at the 404
  // stub so it falls back to the estimate instead of retrying a refused connection.
  const notFound = await startNotFoundServer();
  try {
    await assert.rejects(
      () => runTaskLoop(
        {
          id: 'task-compaction-prompt-overflow',
          question: 'Q'.repeat(20000),
          signals: [],
        },
        {
          ...MOCK_LOOP_DEFAULTS,
          baseUrl: DEAD_BASE_URL,
          model: 'mock-model',
          config: mockLoopConfig({ Runtime: { LlamaCpp: { BaseUrl: notFound.baseUrl } } }),
          maxTurns: 1,
          maxInvalidResponses: 1,
          minToolCallsBeforeFinish: 0,
          totalContextTokens: 7000,
          logger: {
            path: 'memory',
            write(event: Record<string, JsonSerializable>) {
              events.push(parseLoggedEvent(event));
            },
          },
        }
      ),
      /planner_compaction_prompt_overflow/u
    );
  } finally {
    await notFound.close();
  }

  const providerStart = events.find((event) => event.kind === 'provider_request_start');
  assert.equal(Boolean(providerStart), false);
  const overflowEvent = events.find((event) => event.kind === 'turn_compaction_prompt_overflow_fail');
  assert.ok(overflowEvent);
  assert.equal(Number(overflowEvent.remainingTokens) < Number(overflowEvent.minSummaryOutputTokens), true);
});

test('runTaskLoop includes planner provider reserve in dynamic output budget', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-provider-reserve-budget',
      question: 'Find planner budget references.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 1,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 32000,
      mockResponses: [
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );
  const budgetEvent = events.find((event) => event.kind === 'turn_preflight_budget');

  assert.equal(result.reason, 'finish');
  assert.equal(Number(budgetEvent?.providerPromptReserveTokenCount) > 0, true);
  assert.equal(
    Number(budgetEvent?.promptTokenCount),
    Number(budgetEvent?.transcriptPromptTokenCount) + Number(budgetEvent?.providerPromptReserveTokenCount)
  );
  assert.equal(Number(budgetEvent?.maxOutputTokens) > 0, true);
});

test('runTaskLoop compacts an overflowing history and continues from the summary', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-llm-compaction',
      question: 'Find planner references.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      // 15k response reserve leaves a 17000-token prompt budget; the 100k-character
      // history is 25000 tokens at mock mode's 4-characters-per-token estimate, so
      // turn 1 overflows and the compaction summary is the first mock response
      // consumed. The 10k compaction reserve keeps the summarization request fitting.
      totalContextTokens: 32000,
      historyMessages: [{ role: 'assistant', content: 'H'.repeat(100_000) }],
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['git']),
      mockResponses: [
        { content: 'SUMMARY: earlier turns collected planner references under src/.' },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const compactionEvents = events.filter((event) => event.kind === 'turn_preflight_compaction_applied');
  assert.equal(compactionEvents.length, 1);
  assert.equal(Number(compactionEvents[0].droppedMessageCount) > 0, true);
  assert.equal(Number(compactionEvents[0].summaryTokenCount) > 0, true);
  assert.equal(Number(compactionEvents[0].beforeProviderPromptReserveTokenCount) > 0, true);
  assert.equal(Number(compactionEvents[0].providerPromptReserveTokenCount) > 0, true);
  assert.equal(
    Number(compactionEvents[0].afterPromptTokenCount) < Number(compactionEvents[0].beforePromptTokenCount),
    true,
  );
  const allContent = events
    .filter((event) => event.kind === 'turn_new_messages')
    .flatMap((event) => asObjectArray(event.messages))
    .map((message) => String(message.content || ''));
  assert.equal(allContent.some((content) => content.includes('[CONTEXT COMPACTED')), true);
  assert.equal(allContent.some((content) => content.includes('SUMMARY: earlier turns collected')), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.compactionSummary, 'SUMMARY: earlier turns collected planner references under src/.');
});

test('runTaskLoop increases per-tool cap as tool-call progress grows', async () => {
  const events: JsonObject[] = [];
  const totalContextTokens = 20000;
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 10, config: MOCK_LOOP_DEFAULTS.config });
  const baselinePerToolCapTokens = budget.perToolCapTokens(0, 1);
  const expectedThirdCommandCap = budget.perToolCapTokens(2, 1);
  const result = await runTaskLoop(
    {
      id: 'task-dynamic-cap-growth',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 10,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"summary","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"repo","path":"src"} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": { exitCode: 0, stdout: 'planner hit', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"summary\"": { exitCode: 0, stdout: 'summary hit', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"repo\"": { exitCode: 0, stdout: 'repo hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 3);
  assert.equal(commandEvents[0].perToolCapTokens, baselinePerToolCapTokens);
  assert.equal(commandEvents[2].perToolCapTokens, expectedThirdCommandCap);
  assert.equal(commandEvents[2].perToolCapTokens > commandEvents[0].perToolCapTokens, true);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop fits tool output that exceeds remaining token allowance', async () => {
  const events: JsonObject[] = [];
  // 15k goes to the shared response reserve and 10k to the compaction reserve, leaving
  // the 25500 usable prompt tokens this scenario is tuned to.
  const totalContextTokens = 50500;
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 10, config: MOCK_LOOP_DEFAULTS.config });
  const targetQuestionTokens = budget.usablePromptTokens - budget.perToolCapTokens(0, 1) + 1;
  const oversizedQuestion = 'Q'.repeat(Math.ceil(
    targetQuestionTokens * getTokenEstimateCharactersPerToken(undefined),
  ));
  const result = await runTaskLoop(
    {
      id: 'task-remaining-token-guard',
      question: oversizedQuestion,
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 10,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['git']),
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": {
          exitCode: 0,
          stdout: 'x'.repeat(10000),
          stderr: '',
        },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvent = events.find((event) => event.kind === 'turn_command_result');
  assert.equal(typeof commandEvent?.insertedResultText, 'string');
  assert.equal(
    Number(commandEvent?.perToolCapTokens) > Number(commandEvent?.remainingTokenAllowance),
    true,
    JSON.stringify({
      perToolCapTokens: commandEvent?.perToolCapTokens,
      remainingTokenAllowance: commandEvent?.remainingTokenAllowance,
    }),
  );
  assert.doesNotMatch(String(commandEvent?.insertedResultText || ''), /^Error: requested output would consume/u);
  assert.match(String(commandEvent?.insertedResultText || ''), /\d+ lines truncated due to per-tool context limit\./u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop subtracts accepted same-turn tool results from remaining allowance', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-same-turn-token-guard',
      question: 'Find planner prompt and prompt budget helpers.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 10,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 30000,
      mockResponses: [
        { toolCalls: [
          { name: 'git', arguments: { operation: 'grep', pattern: 'planner prompt', path: 'src' } },
          { name: 'git', arguments: { operation: 'grep', pattern: 'prompt budget', path: 'src' } },
        ] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner prompt\"": {
          exitCode: 0,
          stdout: 'src/repo-search/prompts.ts:228:repo-search planner prompt',
          stderr: '',
        },
        "git operation=\"grep\" path=\"src\" pattern=\"prompt budget\"": {
          exitCode: 0,
          stdout: 'src/repo-search/prompt-budget.ts:1:prompt budget helper',
          stderr: '',
        },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 2);
  assert.equal(
    commandEvents[1].remainingTokenAllowance,
    Number(commandEvents[0].remainingTokenAllowance) - Number(commandEvents[0].resultTokenCount)
  );
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop accepts first finish immediately when runtime reasoning is off', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-finish-no-reasoning',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      config: mockLoopConfig({
        ...modelPresetReasoning('off'),
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
          },
        },
      }),
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { content: "first finish" },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 1);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_followup'), false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_auto_accepted'), false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'first finish');
  assert.equal(result.invalidResponses, 0);
});

test('runTaskLoop accepts first finish immediately when runtime reasoning is on', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-finish-with-reasoning',
      question: 'Find planner text.',
      signals: ['final answer'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      config: mockLoopConfig({
        ...modelPresetReasoning('on'),
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
          },
        },
      }),
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { content: "final answer" },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 1);
  assert.equal(turnRequests[0].thinkingEnabled, true);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_followup'), false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_auto_accepted'), false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'final answer');
});

test('runTaskLoop does not emit follow-up finish events after many reasoning-off tool calls', async () => {
  const events: JsonObject[] = [];
  const mockResponses = [
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-1","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-2","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-3","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-4","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-5","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-6","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-7","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-8","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-9","path":"src"} }] },
    { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"hit-10","path":"src"} }] },
    { content: "src\\target.ts:10" },
  ];
  const mockCommandResults = {
    "git operation=\"grep\" path=\"src\" pattern=\"hit-1\"": { exitCode: 0, stdout: 'src\\target.ts:1: hit-1', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-2\"": { exitCode: 0, stdout: 'src\\target.ts:2: hit-2', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-3\"": { exitCode: 0, stdout: 'src\\target.ts:3: hit-3', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-4\"": { exitCode: 0, stdout: 'src\\target.ts:4: hit-4', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-5\"": { exitCode: 0, stdout: 'src\\target.ts:5: hit-5', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-6\"": { exitCode: 0, stdout: 'src\\target.ts:6: hit-6', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-7\"": { exitCode: 0, stdout: 'src\\target.ts:7: hit-7', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-8\"": { exitCode: 0, stdout: 'src\\target.ts:8: hit-8', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-9\"": { exitCode: 0, stdout: 'src\\target.ts:9: hit-9', stderr: '' },
    "git operation=\"grep\" path=\"src\" pattern=\"hit-10\"": { exitCode: 0, stdout: 'src\\target.ts:10: hit-10', stderr: '' },
  };
  const result = await runTaskLoop(
    {
      id: 'task-finish-many-tools-no-followup',
      question: 'Find planner text.',
      signals: ['src\\target.ts:10'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      config: mockLoopConfig({
        ...modelPresetReasoning('off'),
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
          },
        },
      }),
      maxTurns: 11,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses,
      mockCommandResults,
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 11);
  assert.equal(turnRequests.every((event) => event.thinkingEnabled === false), true);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_followup'), false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_auto_accepted'), false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'src\\target.ts:10');
  assert.equal(result.invalidResponses, 0);
});

test('runTaskLoop keeps reasoning disabled across max-turn exhaustion when runtime reasoning is off', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-max-turns-no-reasoning',
      question: 'Find planner text.',
      signals: ['never-hits'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      config: mockLoopConfig({
        ...modelPresetReasoning('off'),
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
          },
        },
      }),
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner2","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner3","path":"src"} }] },
        { content: 'Synthesized best-effort answer.' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": { exitCode: 0, stdout: 'planner', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"planner2\"": { exitCode: 0, stdout: 'planner2', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"planner3\"": { exitCode: 0, stdout: 'planner3', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 3);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[2].thinkingEnabled, false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_followup'), false);
  assert.equal(result.reason, 'max_turns');
});

test('runTaskLoop retries transient provider network failures via shared retry helper', async () => {
  const events: JsonObject[] = [];
  const requestBodies = [];
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requestCount += 1;
      requestBodies.push(JSON.parse(body));

      if (requestCount === 5) {
        req.socket.destroy();
        return;
      }

      const toolIndex = requestCount <= 4 ? requestCount : null;
      const message: JsonObject = toolIndex === null
        ? { content: 'done' }
        : {
            content: '',
            tool_calls: [{
              id: `retry-${toolIndex}`,
              type: 'function',
              function: {
                name: 'git',
                arguments: JSON.stringify({ operation: 'grep', pattern: `q${toolIndex}`, path: 'src' }),
              },
            }],
          };
      sendChatCompletionSse(res, {
        choices: [
          {
            message: {
              ...message,
            },
          },
        ],
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runTaskLoop(
      {
        id: 'task-retry-on-switch',
        question: 'Find planner text.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        baseUrl,
        model: 'mock-model',
        config: mockLoopConfig({ Runtime: { LlamaCpp: { BaseUrl: baseUrl } } }),
        maxTurns: 6,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockCommandResults: {
          "git operation=\"grep\" path=\"src\" pattern=\"q1\"": { exitCode: 0, stdout: 'q1', stderr: '' },
          "git operation=\"grep\" path=\"src\" pattern=\"q2\"": { exitCode: 0, stdout: 'q2', stderr: '' },
          "git operation=\"grep\" path=\"src\" pattern=\"q3\"": { exitCode: 0, stdout: 'q3', stderr: '' },
          "git operation=\"grep\" path=\"src\" pattern=\"q4\"": { exitCode: 0, stdout: 'q4', stderr: '' },
        },
        logger: {
          path: 'memory',
          write(event: Record<string, JsonSerializable>) {
            events.push(parseLoggedEvent(event));
          },
        },
      }
    );

    assert.equal(result.reason, 'finish');
    assert.equal(result.finalOutput, 'done');
    assert.equal(requestCount, 6);
    // Response-format constrained mode suppresses enable_thinking in the HTTP body.
    // Verify the engine still tracks the configured binary reasoning mode in logged events.
    const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
    assert.equal(turnRequests.length >= 5, true);
    assert.equal(Boolean(turnRequests[0]?.thinkingEnabled), false);
    assert.equal(Boolean(turnRequests[3]?.thinkingEnabled), false);
    assert.equal(Boolean(turnRequests[4]?.thinkingEnabled), false);
    const retryEvent = events.find((event) => event.kind === 'provider_request_retry');
    assert.ok(retryEvent);
    assert.equal(retryEvent.stage, 'planner_action');
    assert.equal(retryEvent.attempt, 1);
    assert.equal(Number(retryEvent.nextDelayMs) > 0, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runTaskLoop waits for planner endpoint warm-up when initial connections are refused', async () => {
  const events: JsonObject[] = [];
  await using portLease = await acquireChildPortLease('mock-repo-search-loop');
  const port = portLease.port;
  let delayedServer: http.Server | null = null;
  let plannerRequestCount = 0;
  const delayedStart = setTimeout(() => {
    delayedServer = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      plannerRequestCount += 1;
      sendChatCompletionSse(res, {
        choices: [{ message: { content: 'done' } }],
      });
    });
    delayedServer.listen(port, '127.0.0.1');
  }, 300);
  const notFound = await startNotFoundServer();

  try {
    const result = await runTaskLoop(
      {
        id: 'task-connrefused-warmup',
        question: 'Find planner text.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'mock-model',
        // Preflight tokenizing must not wait on the delayed port, or the planner
        // request would only fire once the endpoint is already up.
        config: mockLoopConfig({ Runtime: { LlamaCpp: { BaseUrl: notFound.baseUrl } } }),
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        logger: {
          path: 'memory',
          write(event: Record<string, JsonSerializable>) {
            events.push(parseLoggedEvent(event));
          },
        },
      }
    );
    assert.equal(result.reason, 'finish');
    assert.equal(result.finalOutput, 'done');
    assert.equal(plannerRequestCount >= 1, true);
    const retryEvents = events.filter((event) => event.kind === 'provider_request_retry');
    assert.equal(retryEvents.length >= 1, true);
    assert.match(String(asObject(retryEvents[0]?.error).message || ''), /ECONNREFUSED/u);
  } finally {
    clearTimeout(delayedStart);
    if (delayedServer) {
      await new Promise<void>((resolve) => delayedServer!.close(() => resolve()));
    }
    await notFound.close();
  }
});

test('runTaskLoop retries planner calls when endpoint returns HTTP 503 Loading model', async () => {
  const events: JsonObject[] = [];
  await using portLease = await acquireChildPortLease('mock-repo-search-loop');
  const port = portLease.port;
  let plannerRequestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    plannerRequestCount += 1;
    if (plannerRequestCount === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Loading model', type: 'unavailable_error', code: 503 } }));
      return;
    }
    sendChatCompletionSse(res, {
      choices: [{ message: { content: 'done' } }],
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  try {
    const result = await runTaskLoop(
      {
        id: 'task-loading-model-retry',
        question: 'Find planner text.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'mock-model',
        config: mockLoopConfig({ Runtime: { LlamaCpp: { BaseUrl: `http://127.0.0.1:${port}` } } }),
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        logger: {
          path: 'memory',
          write(event: Record<string, JsonSerializable>) {
            events.push(parseLoggedEvent(event));
          },
        },
      }
    );
    assert.equal(result.reason, 'finish');
    assert.equal(result.finalOutput, 'done');
    assert.equal(plannerRequestCount, 2);
    const retryEvents = events.filter((event) => event.kind === 'provider_request_retry');
    assert.equal(retryEvents.length >= 1, true);
    assert.match(String(asObject(retryEvents[0]?.error).message || ''), /Loading model/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('runTaskLoop blocks exact duplicate commands with explicit error message', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-duplicate-command',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": { exitCode: 0, stdout: 'src\\planner.ts:10: planner hit', stderr: '' },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.turnsUsed, 3);
  assert.equal(result.commandFailures, 1);
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[1].safe, false);
  assert.equal(String(result.commands[1].reason || ''), 'duplicate command');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop blocks an identical typed Git call as an exact duplicate', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-semantic-duplicate-command',
      question: 'Find port defaults.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"log","limit":5} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"log","limit":5} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"log\" limit=5": {
          exitCode: 0,
          stdout: 'abc1234 add runner port default',
          stderr: '',
        },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[1].safe, false);
  assert.equal(String(result.commands[1].reason || ''), 'duplicate command');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop tracks per-file overlap telemetry and isolates histories across files', async () => {
  const repoRoot = createTempRepoRoot();
  for (const fileName of ['a.ts', 'b.ts']) {
    fs.writeFileSync(
      path.join(repoRoot, fileName),
      Array.from({ length: 200 }, (_, index) => `${fileName}-line-${index + 1}`).join('\n'),
      'utf8',
    );
  }
  const result = await runTaskLoop(
    {
      id: 'task-line-read-overlap-metrics',
      question: 'Read two files.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"a.ts","offset":100,"limit":20} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"b.ts","offset":50,"limit":20} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"a.ts","offset":110,"limit":20} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'finish');
  const overlapSummary = result.readOverlapSummary;
  assert.deepEqual(overlapSummary?.byFile.map((entry) => entry.pathKey), ['a.ts', 'b.ts']);
  // The third read overlaps a.ts lines 110-119, but planRead advances past ranges
  // already returned, so nothing is read twice.
  assert.equal(Number(overlapSummary?.totalOverlapLines), 0);
  assert.equal(
    Number(overlapSummary?.totalLinesRead),
    Number(overlapSummary?.totalUniqueLinesRead),
  );
  // b.ts keeps its own history: one 20-line window, untouched by either a.ts read.
  const bFile = overlapSummary?.byFile.find((entry) => entry.pathKey === 'b.ts');
  assert.equal(Number(bFile?.totalLinesRead), 20);
  assert.equal(Number(bFile?.overlapLines), 0);
});

test('runTaskLoop with ExpandReads disabled skips returned lines but stops at the requested end', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, 'a.ts'),
    Array.from({ length: 200 }, (_, index) => `a.ts-line-${index + 1}`).join('\n'),
    'utf8',
  );
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-expand-reads-disabled',
      question: 'Read a file twice.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      config: mockLoopConfig({ ...modelPresetReasoning('off'), ExpandReads: false }),
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"a.ts","offset":100,"limit":20} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"a.ts","offset":110,"limit":20} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(Number(result.readOverlapSummary?.totalOverlapLines), 0);
  // Second read starts after the returned range and stops at the requested end, not at EOF.
  assert.match(String(commandEvents[1]?.executedCommand || ''), /offset=120 limit=10/u);
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /^120: a\.ts-line-120/mu);
  assert.doesNotMatch(String(commandEvents[1]?.insertedResultText || ''), /^130: a\.ts-line-130/mu);
});

test('runTaskLoop does not compact different commands that happen to return the same evidence', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-collapse-repeat-replay',
      question: 'Find runner port.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"alpha","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"beta","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"gamma","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"delta","path":"src"} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"alpha\"": { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"beta\"": { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"gamma\"": { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"delta\"": { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const turn3NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3);
  assert.equal(Array.isArray(turn2NewMessages?.messages) ? turn2NewMessages.messages.length : -1, 2);
  assert.equal(Array.isArray(turn3NewMessages?.messages) ? turn3NewMessages.messages.length : -1, 2);

  const forcedStart = events.find((event) => event.kind === 'turn_forced_finish_mode_started' && event.trigger === 'no_new_evidence');
  assert.equal(Boolean(forcedStart), false);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop forces finish mode after ten zero-output commands', async () => {
  const events: JsonObject[] = [];
  const mockResponses: MockPlannerResponseInput[] = [];
  const mockCommandResults: Record<string, { exitCode: number; stdout: string; stderr: string }> = {};
  for (let index = 1; index <= 10; index += 1) {
    const command = `git operation="grep" path="src" pattern="q${index}"`;
    mockResponses.push({ toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: `q${index}`, path: 'src' } }] });
    mockCommandResults[command] = { exitCode: 0, stdout: '', stderr: '' };
  }
  mockResponses.push({ toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'forced', path: 'src' } }] });
  mockResponses.push({ content: 'forced conclusion' });
  const result = await runTaskLoop(
    {
      id: 'task-zero-output-force-finish',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 12,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses,
      mockCommandResults,
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const forcedStart = events.find((event) => event.kind === 'turn_forced_finish_mode_started');
  assert.ok(forcedStart);
  const turn11Request = events.find((event) => event.kind === 'turn_model_request' && event.turn === 11);
  assert.ok(turn11Request);
  assert.equal(turn11Request.thinkingEnabled, false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'forced conclusion');
});

test('runTaskLoop enables thinking on every tool-call turn when runtime reasoning is on', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-third-cadence',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      config: mockLoopConfig({
        ...modelPresetReasoning('on'),
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
          },
        },
      }),
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"a","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"b","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"c","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"d","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"e","path":"src"} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"a\"": { exitCode: 0, stdout: 'a', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"b\"": { exitCode: 0, stdout: 'b', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"c\"": { exitCode: 0, stdout: 'c', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"d\"": { exitCode: 0, stdout: 'd', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"e\"": { exitCode: 0, stdout: 'e', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 6);
  assert.equal(turnRequests[0].thinkingEnabled, true);
  assert.equal(turnRequests[1].thinkingEnabled, true);
  assert.equal(turnRequests[2].thinkingEnabled, true);
  assert.equal(turnRequests[3].thinkingEnabled, true);
  assert.equal(turnRequests[4].thinkingEnabled, true);
  assert.equal(turnRequests[5].thinkingEnabled, true);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop disables thinking on every tool-call turn when runtime reasoning is off', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-no-thinking',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      config: mockLoopConfig({
        ...modelPresetReasoning('off'),
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
          },
        },
      }),
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"a","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"b","path":"src"} }] },
        { content: "done" },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"a\"": { exitCode: 0, stdout: 'a', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"b\"": { exitCode: 0, stdout: 'b', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    },
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 3);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, false);
  assert.equal(turnRequests[2].thinkingEnabled, false);
  assert.equal(result.reason, 'finish');
});

test('buildScorecard aggregates totals and verdict', () => {
  const scorecard = buildScorecard({
    runId: 'run-1',
    model: 'model-x',
    tasks: [
      mockTaskResult({
        id: 'a',
        passed: true,
        safetyRejects: 1,
        invalidResponses: 0,
        commandFailures: 0,
        commands: [{ command: 'rg x', turn: 1, safe: true, reason: null, exitCode: 0, output: '' }],
        missingSignals: [],
      }),
      mockTaskResult({
        id: 'b',
        passed: false,
        safetyRejects: 2,
        invalidResponses: 1,
        commandFailures: 1,
        commands: [
          { command: 'rg y', turn: 1, safe: true, reason: null, exitCode: 0, output: '' },
          { command: 'rg z', turn: 2, safe: false, reason: null, exitCode: 0, output: '' },
        ],
        missingSignals: ['signal-1'],
      }),
    ],
  });

  assert.equal(scorecard.totals.tasks, 2);
  assert.equal(scorecard.totals.passed, 1);
  assert.equal(scorecard.totals.failed, 1);
  assert.equal(scorecard.totals.safetyRejects, 3);
  assert.equal(scorecard.totals.invalidResponses, 1);
  assert.equal(scorecard.totals.commandFailures, 1);
  assert.equal(scorecard.totals.commandsExecuted, 3);
  assert.equal(scorecard.verdict, 'fail');
  assert.equal(scorecard.failureReasons.length, 2);
});

test('mock planner strips think block from response text', async () => {
  const events: JsonObject[] = [];
  await runTaskLoop(
    { id: 'task-strip', question: 'q', signals: ['done'] },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1, maxInvalidResponses: 2, minToolCallsBeforeFinish: 0,
      mockResponses: [{ thinking: 'hidden', content: 'done' }],
      mockCommandResults: {},
      logger: { path: 'memory', write(event: Record<string, JsonSerializable>) { events.push(parseLoggedEvent(event)); } },
    }
  );
  const response = events.find((e) => e.kind === 'turn_model_response');
  assert.equal(response?.thinkingText, 'hidden');
  assert.equal(response?.text, 'done');
});

test('runTaskLoop records real planner turn per command and per-turn thinking', async () => {
  const result = await runTaskLoop(
    { id: 'task-turns', question: 'Find planner text.', signals: ['done'] },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { thinking: 'plan step a', toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'a', path: 'src' } }] },
        { thinking: 'plan step b', toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'b', path: 'src' } }] },
        { thinking: 'final reasoning', content: 'done' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"a\"": { exitCode: 0, stdout: 'a', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"b\"": { exitCode: 0, stdout: 'b', stderr: '' },
      },
    }
  );
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].turn, 1);
  assert.equal(result.commands[1].turn, 2);
  assert.equal(result.turnThinking[1], 'plan step a');
  assert.equal(result.turnThinking[2], 'plan step b');
  assert.equal(result.turnThinking[3], 'final reasoning');
});

test('runTaskLoop keeps only latest planner thinking when per-step thinking is disabled', async () => {
  const result = await runTaskLoop(
    { id: 'task-turns-pruned', question: 'Find planner text.', signals: ['done'] },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      config: mockLoopConfig({
        Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 32000 } },
        Server: {
          ModelPresets: {
            ActivePresetId: 'thinking-off',
            Presets: [{
              id: 'thinking-off',
              Reasoning: 'on',
              ReasoningContent: true,
              PreserveThinking: true,
              MaintainPerStepThinking: false,
              IdleAction: 'unload',
            }],
          },
        },
      }),
      mockResponses: [
        { thinking: 'plan step a', toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'a', path: 'src' } }] },
        { thinking: 'plan step b', toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'b', path: 'src' } }] },
        { thinking: 'final reasoning', content: 'done' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"a\"": { exitCode: 0, stdout: 'a', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"b\"": { exitCode: 0, stdout: 'b', stderr: '' },
      },
    }
  );
  assert.deepEqual(Object.keys(result.turnThinking), ['3']);
  assert.equal(result.turnThinking[3], 'final reasoning');
});

test('runTaskLoop sets turn on a duplicate-rejected command push', async () => {
  const result = await runTaskLoop(
    { id: 'task-dup-turn', question: 'Find planner text.', signals: [] },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"planner","path":"src"} }] },
        { content: "done" },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": { exitCode: 0, stdout: 'hit', stderr: '' },
      },
    }
  );
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].turn, 1);
  assert.equal(result.commands[1].safe, false);
  assert.equal(String(result.commands[1].reason || ''), 'duplicate command');
  assert.equal(result.commands[1].turn, 2);
});

test('runTaskLoop records turn thinking for an invalid-parse turn', async () => {
  const result = await runTaskLoop(
    { id: 'task-invalid-think', question: 'q', signals: ['done'] },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { thinking: 'bad reasoning' },
        { thinking: 'final', content: 'done' },
      ],
      mockCommandResults: {},
    }
  );
  // The invalid-parse turn (no command pushed) still records its thinking.
  assert.equal(result.turnThinking[1], 'bad reasoning');
  assert.equal(result.turnThinking[2], 'final');
});

test('runTaskLoop lets a read repeat after an edit invalidates the file window', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-read-after-edit',
      question: 'Read and edit target file.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'edit']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { toolCalls: [{ name: "edit", arguments: {"path":"target.ts","edits":[{"oldText":"line-2","newText":"line-2-EDITED"}]} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  // read, edit, read â€” the third call executed instead of being rejected.
  assert.equal(commandEvents.length, 3);
  assert.match(String(commandEvents[2]?.insertedResultText || ''), /^1: line-1/mu);
  assert.match(String(commandEvents[2]?.insertedResultText || ''), /^2: line-2-EDITED/mu);
});

test('runTaskLoop keeps read history across a typed read-only Git call', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-read-after-git',
      question: 'Read target file around a git call.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'git']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { toolCalls: [{ name: "git", arguments: {"operation":"status"} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        "git operation=\"status\"": { exitCode: 0, stdout: ' M target.ts', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 1);
  assert.equal(commandEvents.length, 2);
  assert.equal(result.commands[2]?.reason, 'exhausted read');
});

test('runTaskLoop lets a read repeat after run invalidates every window with ExpandReads off', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  // `run` is native, so the mock key is the synthetic command string, not a shell line.
  const runCommandKey = buildRepoToolRequestedCommand('run', { command: 'npm run lint' });
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-read-after-run',
      question: 'Read target file around a run call.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      config: mockLoopConfig({ ...modelPresetReasoning('off'), ExpandReads: false }),
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'run']),
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { toolCalls: [{ name: "run", arguments: {"command":"npm run lint"} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"target.ts","offset":1,"limit":3} }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        [runCommandKey]: { exitCode: 0, stdout: 'lint clean', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(commandEvents.length, 3);
  assert.match(String(commandEvents[2]?.insertedResultText || ''), /^1: line-1/mu);
});
