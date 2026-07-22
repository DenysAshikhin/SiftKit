import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from '../src/lib/zod.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { JsonObjectSchema, type JsonObject, type JsonSerializable } from '../src/lib/json-types.js';
import { asObject, asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';

import { isTransientProviderError, retryProviderRequest } from '../src/lib/provider-helpers.js';
import {
  runTaskLoop,
  buildScorecard,
  assertConfiguredModelPresent,
  runRepoSearch,
  type TaskResult,
} from '../src/repo-search/engine.js';
import { resolveRepoSearchPlannerToolDefinitions, type ChatMessage } from '../src/repo-search/planner-protocol.js';
import { buildTaskSystemPrompt } from '../src/repo-search/prompts.js';
import {
  preflightPlannerPromptBudget,
  compactPlannerMessagesOnce,
} from '../src/repo-search/prompt-budget.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';

// Mock-mode runTaskLoop calls never reach a real provider or repo; these defaults
// satisfy the required RunTaskLoopOptions fields. Per-test options override them.
const MOCK_LOOP_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-mock-loop-'));
const MOCK_LOOP_DEFAULTS = {
  repoRoot: MOCK_LOOP_REPO_ROOT,
  model: 'mock-model',
  baseUrl: 'http://127.0.0.1:1',
};

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

function modelPresetReasoning(reasoning: 'on' | 'off'): DeepPartial<SiftConfig> {
  return {
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{ id: 'default', Reasoning: reasoning }],
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

// Logged events may carry undefined-valued fields; the real JSONL logger drops
// them via JSON.stringify, so normalize the same way before schema-validating.
function parseLoggedEvent(event: Record<string, JsonSerializable>): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(JSON.stringify(event)));
}

function createTempRepoRoot(gitignoreText = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-ignore-'));
  fs.writeFileSync(path.join(root, '.gitignore'), gitignoreText, 'utf8');
  return root;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = Number(address && typeof address === 'object' ? address.port : 0);
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
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
      mockResponses: ['oops', 'still bad', 'Synthesized best-effort answer.'],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'invalid_response_limit');
  assert.equal(result.invalidResponses, 2);
  assert.equal(result.commands.length, 0);
  assert.equal(result.finalOutput, 'Synthesized best-effort answer.');
});

test('runTaskLoop repairs malformed planner payloads before executing tool calls', async () => {
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
        '{"action":"git","command":"git grep -n \\"planner\\" src"',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': {
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
  const turn2Messages = plannerLogMessages(turn2NewMessages);
  const assistantMessage = turn2Messages.find((message) => message.role === 'assistant');
  const toolMessage = turn2Messages.find((message) => message.role === 'tool');
  const userMessages = turn2Messages.filter((message) => message.role === 'user');
  const assistantToolCall = assistantMessage?.tool_calls?.[0] ?? null;

  assert.equal(result.reason, 'finish');
  assert.equal(result.invalidResponses, 0);
  assert.equal(String(assistantToolCall?.function?.name || ''), 'git');
  assert.equal(JSON.parse(String(assistantToolCall?.function?.arguments || '{}')).command, 'git grep -n "planner" src');
  assert.match(String(toolMessage?.content || ''), /planner anchor/u);
  assert.equal(userMessages.length, 0);
});

test('runTaskLoop replays unrecoverable invalid planner payloads through invalid_tool_call', async () => {
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
        'oops',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
  const assistantToolCall = assistantMessage?.tool_calls?.[0] ?? null;
  const assistantArgs = JSON.parse(String(assistantToolCall?.function?.arguments || '{}'));

  assert.equal(result.reason, 'finish');
  assert.equal(String(assistantToolCall?.function?.name || ''), 'invalid_tool_call');
  assert.equal(String(assistantArgs?.rawResponseText || ''), 'oops');
  assert.match(String(toolMessage?.content || ''), /Provider returned an invalid planner payload/u);
  assert.equal(userMessages.length, 0);
});

test('runTaskLoop cuts off runaway streamed tool JSON and reprompts once', { timeout: 5000 }, async () => {
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
              content: '{"action":"tool_batch","calls":[{"action":"git","command":"git grep -n \\"planner\\" src"}]}'
                + '}'.repeat(220),
            },
          }],
        })}\n\n`
      );
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: '{"action":"finish","output":"done"}' } }],
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

    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1200));
    const result = await Promise.race([resultPromise, timeout]);
    assert.notEqual(result, 'timeout');
    if (result === 'timeout') {
      return;
    }

    const invalidEvent = events.find((event) => event.kind === 'turn_action_invalid');
    const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
    const turn2Messages = plannerLogMessages(turn2NewMessages);
    const assistantMessage = turn2Messages.find((message) => message.role === 'assistant');
    const assistantToolCall = assistantMessage?.tool_calls?.[0] ?? null;

    assert.equal(result.reason, 'finish');
    assert.equal(result.invalidResponses, 1);
    assert.equal(requestCount, 2);
    assert.equal(firstStreamClosed, true);
    assert.equal(String(assistantToolCall?.function?.name || ''), 'invalid_tool_call');
    assert.match(String(invalidEvent?.error || ''), /invalid planner payload/u);
    assert.equal(progressEvents.some((event) => String(event.thinkingText || '').includes('}'.repeat(220))), false);
  } finally {
    controller.abort(new Error('test cleanup'));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('runTaskLoop truncates oversized rg output to the largest fitting prefix', async () => {
  const events: JsonObject[] = [];
  const totalContextTokens = 20000;
  const thinkingBufferTokens = Math.max(Math.ceil(totalContextTokens * 0.15), 4000);
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const baselinePerToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * 0.10));
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': {
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
        "{\"action\":\"read\",\"path\":\"target.ts\",\"offset\":1,\"limit\":5}",
        "{\"action\":\"read\",\"path\":\"target.ts\",\"offset\":1,\"limit\":5}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        '{"action":"read","path":"src/big-file.ts","offset":1,"limit":80}',
        '{"action":"read","path":"src/big-file.ts","offset":40,"limit":51}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
  const replayedAssistantArgs = JSON.parse(String(replayedAssistantAction?.function?.arguments || '{}'));

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
        '{"action":"git","command":"git grep -n \\"needle\\" src"}',
        '{"action":"read","path":"src/big.ts","offset":300,"limit":601}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "needle" src': { exitCode: 0, stdout: 'src/big.ts:300:needle', stderr: '', delayMs: 5 },
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
  const args = asObject(parseJsonValueText(String(fn.arguments || '{}')));
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
        "{\"action\":\"read\",\"path\":\"target.ts\",\"offset\":11,\"limit\":5}",
        "{\"action\":\"read\",\"path\":\"target.ts\",\"offset\":1,\"limit\":20}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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

test('runTaskLoop reports when read has no unread lines left', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  await runTaskLoop(
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
        "{\"action\":\"read\",\"path\":\"target.ts\",\"offset\":1,\"limit\":3}",
        "{\"action\":\"read\",\"path\":\"target.ts\",\"offset\":1,\"limit\":3}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
  assert.match(String(commandEvents[1]?.insertedResultText || ''), /No unread lines remain for target\.ts\./u);
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
      includeRepoFileListing: false,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['find']),
      mockResponses: [
        "{\"action\":\"find\",\"pattern\":\"*.ts\",\"path\":\".\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
      includeRepoFileListing: false,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        '{"action":"read","path":"big.ts","offset":1,"limit":300}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
          "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {
          'git grep -n "planner" src': {
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
    totalContextTokens: 7000,
    thinkingBufferTokens: 4000,
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
    totalContextTokens: 4200,
    thinkingBufferTokens: 4000,
  });
  const withReserve = await preflightPlannerPromptBudget({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'short request' },
    ],
    providerPromptReserveText: 'provider tools and response schema '.repeat(900),
    totalContextTokens: 4200,
    thinkingBufferTokens: 4000,
  });

  assert.equal(withoutReserve.ok, true);
  assert.equal(withReserve.ok, false);
  assert.equal(withReserve.providerPromptReserveTokenCount > 0, true);
  assert.equal(withReserve.promptTokenCount > withoutReserve.promptTokenCount, true);
  assert.equal(withReserve.promptTokenCount > withReserve.maxPromptBudget, true);
});

test('compactPlannerMessagesOnce preserves system and latest user intent', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system message' },
    { role: 'user', content: 'first user intent' },
    { role: 'assistant', content: 'older assistant details ' + 'a'.repeat(2000) },
    { role: 'tool', content: 'older tool output ' + 'b'.repeat(4000), tool_call_id: 'call_1' },
    { role: 'user', content: 'latest user intent must remain' },
    { role: 'assistant', content: 'most recent assistant context' },
  ];
  const compacted = await compactPlannerMessagesOnce({
    messages,
    maxPromptBudget: 600,
  });
  const transcript = compacted.messages.map((message) => String(message.content || '')).join('\n');

  assert.equal(compacted.droppedMessageCount > 0, true);
  assert.equal(compacted.summaryInserted, true);
  assert.match(transcript, /\[COMPRESSED HISTORICAL EVIDENCE\]/u);
  assert.match(transcript, /latest user intent must remain/u);
  assert.match(String(compacted.messages[0]?.role || ''), /^system$/u);
});

test('compactPlannerMessagesOnce budgets provider prompt overhead while selecting history', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system message' },
    { role: 'assistant', content: 'older assistant details ' + 'a'.repeat(2000) },
    { role: 'tool', content: 'older tool output ' + 'b'.repeat(2000), tool_call_id: 'call_1' },
    { role: 'user', content: 'latest user intent must remain' },
  ];
  const compacted = await compactPlannerMessagesOnce({
    messages,
    providerPromptReserveText: 'provider overhead '.repeat(500),
    maxPromptBudget: 2800,
  });
  const transcript = compacted.messages.map((message) => String(message.content || '')).join('\n');

  assert.equal(compacted.droppedMessageCount > 0, true);
  assert.equal(compacted.promptTokenCount <= 2800, true);
  assert.match(transcript, /latest user intent must remain/u);
  assert.match(String(compacted.messages[0]?.role || ''), /^system$/u);
});

test('runTaskLoop fails with planner_preflight_overflow before provider request when compaction cannot fit', async () => {
  const events: JsonObject[] = [];
  await assert.rejects(
    () => runTaskLoop(
      {
        id: 'task-preflight-overflow-hard-fail',
        question: 'Q'.repeat(12000),
        signals: [],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        baseUrl: 'http://127.0.0.1:1',
        model: 'mock-model',
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
    /planner_preflight_overflow/u
  );

  const providerStart = events.find((event) => event.kind === 'provider_request_start');
  assert.equal(Boolean(providerStart), false);
  const overflowEvent = events.find((event) => event.kind === 'turn_preflight_overflow_fail');
  assert.ok(overflowEvent);
  assert.equal(Number(overflowEvent.overflowTokens) > 0, true);
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
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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

test('runTaskLoop applies one-pass compaction and continues when compacted prompt fits', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-preflight-compaction-success',
      question: 'Find planner references.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 10,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 7200,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['git']),
      mockResponses: [
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" lib\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" test\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" docs\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" scripts\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" examples\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" fixtures\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': { exitCode: 0, stdout: Array.from({ length: 500 }, (_, index) => `a-${index}`).join(' '), stderr: '' },
        'git grep -n "planner" lib': { exitCode: 0, stdout: Array.from({ length: 500 }, (_, index) => `b-${index}`).join(' '), stderr: '' },
        'git grep -n "planner" test': { exitCode: 0, stdout: Array.from({ length: 500 }, (_, index) => `c-${index}`).join(' '), stderr: '' },
        'git grep -n "planner" docs': { exitCode: 0, stdout: Array.from({ length: 500 }, (_, index) => `d-${index}`).join(' '), stderr: '' },
        'git grep -n "planner" scripts': { exitCode: 0, stdout: Array.from({ length: 500 }, (_, index) => `e-${index}`).join(' '), stderr: '' },
        'git grep -n "planner" examples': { exitCode: 0, stdout: Array.from({ length: 320 }, (_, index) => `f-${index}`).join(' '), stderr: '' },
        'git grep -n "planner" fixtures': { exitCode: 0, stdout: Array.from({ length: 320 }, (_, index) => `g-${index}`).join(' '), stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const compactionEvents = events.filter((event) => event.kind === 'turn_preflight_compaction_applied');
  assert.equal(compactionEvents.length >= 1, true);
  assert.equal(Number(compactionEvents[0].droppedMessageCount) > 0, true);
  assert.equal(Number(compactionEvents[0].beforeProviderPromptReserveTokenCount) > 0, true);
  assert.equal(Number(compactionEvents[0].providerPromptReserveTokenCount) > 0, true);
  const newMessagesEvents = events.filter((event) => event.kind === 'turn_new_messages');
  const allCompactedContent = newMessagesEvents
    .flatMap((event) => asObjectArray(event.messages))
    .map((m) => String(m.content || ''));
  assert.equal(allCompactedContent.some((c) => c.includes('[COMPRESSED HISTORICAL EVIDENCE]')), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop increases per-tool cap as tool-call progress grows', async () => {
  const events: JsonObject[] = [];
  const totalContextTokens = 20000;
  const thinkingBufferTokens = Math.max(Math.ceil(totalContextTokens * 0.15), 4000);
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const baselinePerToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * 0.10));
  const expectedThirdCommandCap = Math.max(1, Math.floor(usablePromptTokens * (2 / 10)));
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"summary\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"repo\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
        'git grep -n "summary" src': { exitCode: 0, stdout: 'summary hit', stderr: '' },
        'git grep -n "repo" src': { exitCode: 0, stdout: 'repo hit', stderr: '' },
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
  const totalContextTokens = 30000;
  // Sized to pin the regime where remainingTokenAllowance < perToolCapTokens after
  // the system prompt + question consume most of totalContextTokens. The prior
  // 84_000 was tuned to the older, larger system prompt; bumped to keep the
  // assertion pinned to the same budget regime after the prompt was compressed.
  const oversizedQuestion = 'Q'.repeat(90000);
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': {
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
  assert.equal(Number(commandEvent?.perToolCapTokens) > Number(commandEvent?.remainingTokenAllowance), true);
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
        JSON.stringify({
          action: 'tool_batch',
          calls: [
            { action: 'git', command: 'git grep -n "planner prompt" src' },
            { action: 'git', command: 'git grep -n "prompt budget" src' },
          ],
        }),
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner prompt" src': {
          exitCode: 0,
          stdout: 'src/repo-search/prompts.ts:228:repo-search planner prompt',
          stderr: '',
        },
        'git grep -n "prompt budget" src': {
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
        '{"action":"finish","output":"first finish"}',
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
        '{"action":"finish","output":"final answer"}',
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
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-1\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-2\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-3\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-4\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-5\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-6\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-7\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-8\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-9\\\" src\"}",
    "{\"action\":\"git\",\"command\":\"git grep -n \\\"hit-10\\\" src\"}",
    '{"action":"finish","output":"src\\\\target.ts:10"}',
  ];
  const mockCommandResults = {
    'git grep -n "hit-1" src': { exitCode: 0, stdout: 'src\\target.ts:1: hit-1', stderr: '' },
    'git grep -n "hit-2" src': { exitCode: 0, stdout: 'src\\target.ts:2: hit-2', stderr: '' },
    'git grep -n "hit-3" src': { exitCode: 0, stdout: 'src\\target.ts:3: hit-3', stderr: '' },
    'git grep -n "hit-4" src': { exitCode: 0, stdout: 'src\\target.ts:4: hit-4', stderr: '' },
    'git grep -n "hit-5" src': { exitCode: 0, stdout: 'src\\target.ts:5: hit-5', stderr: '' },
    'git grep -n "hit-6" src': { exitCode: 0, stdout: 'src\\target.ts:6: hit-6', stderr: '' },
    'git grep -n "hit-7" src': { exitCode: 0, stdout: 'src\\target.ts:7: hit-7', stderr: '' },
    'git grep -n "hit-8" src': { exitCode: 0, stdout: 'src\\target.ts:8: hit-8', stderr: '' },
    'git grep -n "hit-9" src': { exitCode: 0, stdout: 'src\\target.ts:9: hit-9', stderr: '' },
    'git grep -n "hit-10" src': { exitCode: 0, stdout: 'src\\target.ts:10: hit-10', stderr: '' },
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner2\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner3\\\" src\"}",
        'Synthesized best-effort answer.',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': { exitCode: 0, stdout: 'planner', stderr: '' },
        'git grep -n "planner2" src': { exitCode: 0, stdout: 'planner2', stderr: '' },
        'git grep -n "planner3" src': { exitCode: 0, stdout: 'planner3', stderr: '' },
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
      const content = toolIndex === null
        ? '{"action":"finish","output":"done"}'
        : `{"action":"git","command":"git grep -n \\"q${toolIndex}\\" src"}`;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content,
            },
          },
        ],
      }));
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
        maxTurns: 6,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockCommandResults: {
          'git grep -n "q1" src': { exitCode: 0, stdout: 'q1', stderr: '' },
          'git grep -n "q2" src': { exitCode: 0, stdout: 'q2', stderr: '' },
          'git grep -n "q3" src': { exitCode: 0, stdout: 'q3', stderr: '' },
          'git grep -n "q4" src': { exitCode: 0, stdout: 'q4', stderr: '' },
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
  const port = await getFreePort();
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
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
      }));
    });
    delayedServer.listen(port, '127.0.0.1');
  }, 300);

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
  }
});

test('runTaskLoop retries planner calls when endpoint returns HTTP 503 Loading model', async () => {
  const events: JsonObject[] = [];
  const port = await getFreePort();
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
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
    }));
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': { exitCode: 0, stdout: 'src\\planner.ts:10: planner hit', stderr: '' },
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

test('runTaskLoop blocks semantic duplicate repo-search commands with explicit error message', async () => {
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
        '{"action":"git","command":"git log -n 5 --oneline"}',
        // Same command, only respaced and recased — a different raw key, the same fingerprint.
        '{"action":"git","command":"git LOG  -n   5 --oneline"}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git log -n 5 --oneline': {
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
  assert.equal(String(result.commands[1].reason || ''), 'semantic duplicate command');
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
      includeRepoFileListing: false,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        '{"action":"read","path":"a.ts","offset":100,"limit":20}',
        '{"action":"read","path":"b.ts","offset":50,"limit":20}',
        '{"action":"read","path":"a.ts","offset":110,"limit":20}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"alpha\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"beta\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"gamma\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"delta\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "alpha" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        'git grep -n "beta" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        'git grep -n "gamma" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        'git grep -n "delta" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
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
  const mockResponses: string[] = [];
  const mockCommandResults: Record<string, { exitCode: number; stdout: string; stderr: string }> = {};
  for (let index = 1; index <= 10; index += 1) {
    const command = `git grep -n q${index} src`;
    mockResponses.push(`{"action":"git","command":"${command}"}`);
    mockCommandResults[command] = { exitCode: 0, stdout: '', stderr: '' };
  }
  mockResponses.push("{\"action\":\"git\",\"command\":\"git grep -n forced src\"}");
  mockResponses.push('{"action":"finish","output":"forced conclusion"}');
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"a\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"b\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"c\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"d\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"e\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "a" src': { exitCode: 0, stdout: 'a', stderr: '' },
        'git grep -n "b" src': { exitCode: 0, stdout: 'b', stderr: '' },
        'git grep -n "c" src': { exitCode: 0, stdout: 'c', stderr: '' },
        'git grep -n "d" src': { exitCode: 0, stdout: 'd', stderr: '' },
        'git grep -n "e" src': { exitCode: 0, stdout: 'e', stderr: '' },
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
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"a\\\" src\"}",
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"b\\\" src\"}",
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'git grep -n "a" src': { exitCode: 0, stdout: 'a', stderr: '' },
        'git grep -n "b" src': { exitCode: 0, stdout: 'b', stderr: '' },
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
      mockResponses: ['<think>hidden</think>{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: { path: 'memory', write(event: Record<string, JsonSerializable>) { events.push(parseLoggedEvent(event)); } },
    }
  );
  const response = events.find((e) => e.kind === 'turn_model_response');
  assert.equal(response?.thinkingText, 'hidden');
  assert.equal(response?.text, '{"action":"finish","output":"done"}');
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
        '<think>plan step a</think>{"action":"git","command":"git grep -n \\"a\\" src"}',
        '<think>plan step b</think>{"action":"git","command":"git grep -n \\"b\\" src"}',
        '<think>final reasoning</think>{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'git grep -n "a" src': { exitCode: 0, stdout: 'a', stderr: '' },
        'git grep -n "b" src': { exitCode: 0, stdout: 'b', stderr: '' },
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
        Runtime: { LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
        Server: {
          ModelPresets: {
            ActivePresetId: 'thinking-off',
            Presets: [{
              id: 'thinking-off',
              Reasoning: 'on',
              ReasoningContent: true,
              PreserveThinking: true,
              MaintainPerStepThinking: false,
            }],
          },
        },
      }),
      mockResponses: [
        '<think>plan step a</think>{"action":"git","command":"git grep -n \\"a\\" src"}',
        '<think>plan step b</think>{"action":"git","command":"git grep -n \\"b\\" src"}',
        '<think>final reasoning</think>{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'git grep -n "a" src': { exitCode: 0, stdout: 'a', stderr: '' },
        'git grep -n "b" src': { exitCode: 0, stdout: 'b', stderr: '' },
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
        '{"action":"git","command":"git grep -n \\"planner\\" src"}',
        '{"action":"git","command":"git grep -n \\"planner\\" src"}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': { exitCode: 0, stdout: 'hit', stderr: '' },
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
        '<think>bad reasoning</think>not valid json',
        '<think>final</think>{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {},
    }
  );
  // The invalid-parse turn (no command pushed) still records its thinking.
  assert.equal(result.turnThinking[1], 'bad reasoning');
  assert.equal(result.turnThinking[2], 'final');
});
