import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModelJson } from '../src/lib/model-json.js';
import { getRepoSearchToolNamesForParsing } from '../src/repo-search/planner-protocol.js';
import { isTransientProviderError, retryProviderRequest } from '../src/lib/provider-helpers.js';
import {
  runTaskLoop,
  buildScorecard,
  assertConfiguredModelPresent,
  runRepoSearch,
} from '../src/repo-search/engine.js';
import { buildTaskSystemPrompt } from '../src/repo-search/prompts.js';
import {
  preflightPlannerPromptBudget,
  compactPlannerMessagesOnce,
} from '../src/repo-search/prompt-budget.js';
import { getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import type { SiftConfig } from '../src/config/types.js';

// Mock-mode runTaskLoop calls do not reach a real provider or repo; these defaults
// satisfy the required RunTaskLoopOptions fields with an empty repo root (behaviour-
// equivalent to the values previously omitted while the file was untyped).
const MOCK_LOOP_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-mock-loop-'));
const MOCK_LOOP_DEFAULTS = {
  repoRoot: MOCK_LOOP_REPO_ROOT,
  model: 'mock-model',
  baseUrl: 'http://127.0.0.1:1',
};

// These mock-mode loops read only Runtime.{Model,LlamaCpp}; the rest of the SiftConfig
// surface is irrelevant, so a deliberately partial literal is cast here (one place).
function mockConfig(config: { Runtime: { Model: string; LlamaCpp: Record<string, unknown> } }): SiftConfig {
  return config as unknown as SiftConfig;
}

function createTempRepoRoot(gitignoreText = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-ignore-'));
  fs.writeFileSync(path.join(root, '.gitignore'), gitignoreText, 'utf8');
  return root;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
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

test('assertConfiguredModelPresent hard-fails when configured model is missing', () => {
  assert.throws(
    () => assertConfiguredModelPresent('Qwen3.5-9B-Q8_0.gguf', ['Qwen3.5-27B-Q4_K_M.gguf']),
    /Configured model not found/u
  );
});

test('runRepoSearch does not fail on model inventory mismatch', async () => {
  const scorecard = await runRepoSearch({
    config: {
      Runtime: {
        Model: 'Qwen3.5-9B-Q8_0.gguf',
        LlamaCpp: {
          BaseUrl: 'http://127.0.0.1:8097',
          NumCtx: 70000,
        },
      },
    },
    model: 'Qwen3.5-9B-Q8_0.gguf',
    baseUrl: 'http://127.0.0.1:8097',
    availableModels: ['Qwen3.5-27B-Q4_K_M.gguf'],
    maxTurns: 1,
    taskPrompt: 'find anything',
    mockResponses: [
      '{"action":"finish","output":"done"}',
    ],
    mockCommandResults: {},
  });

  assert.equal(scorecard.verdict, 'pass');
});

test('repo-search executes a native web_search tool when allowed', async () => {
  const events: Record<string, unknown>[] = [];
  const scorecard = await runRepoSearch({
    config: {
      Runtime: { Model: 'Qwen3.5-9B-Q8_0.gguf', LlamaCpp: { BaseUrl: 'http://127.0.0.1:8097', NumCtx: 70000 } },
      WebSearch: {
        EnabledDefault: true,
        Providers: { tavily: { Enabled: true, ApiKey: 'test-key' }, firecrawl: { Enabled: false, ApiKey: '' } },
        ProviderOrder: ['tavily', 'firecrawl'],
        ResultCount: 5,
        FetchMaxPages: 3,
        TimeoutMs: 15000,
        FetchMaxCharacters: 12000,
      },
    },
    model: 'Qwen3.5-9B-Q8_0.gguf',
    baseUrl: 'http://127.0.0.1:8097',
    availableModels: ['Qwen3.5-9B-Q8_0.gguf'],
    allowedTools: ['web_search'],
    maxTurns: 2,
    taskPrompt: 'find latest siftkit info',
    mockResponses: [
      '{"action":"web_search","query":"siftkit"}',
      '{"action":"finish","output":"done"}',
    ],
    mockCommandResults: {
      'web_search query="siftkit"': {
        exitCode: 0,
        stdout: '1. SiftKit\nURL: https://example.com/siftkit\nSnippet: web result snippet\nSource: tavily',
      },
    },
    onProgress: (event) => events.push(event),
  });

  assert.equal(scorecard.verdict, 'pass');
  const toolStart = events.find((event) => event.kind === 'tool_start');
  const toolResult = events.find((event) => event.kind === 'tool_result');
  assert.equal(toolStart?.command, 'web_search query="siftkit"');
  assert.match(String(toolResult?.outputSnippet || ''), /web result snippet|example\.com/);
  assert.equal(Object.keys(scorecard.toolStats).includes('web_search'), true);
});

test('getDynamicMaxOutputTokens uses the smaller of 25k tokens or 90% of remaining context', () => {
  assert.equal(getDynamicMaxOutputTokens({ totalContextTokens: 8192, promptTokenCount: 1000 }), 6472);
  assert.equal(getDynamicMaxOutputTokens({ totalContextTokens: 128000, promptTokenCount: 12239 }), 25000);
  assert.equal(getDynamicMaxOutputTokens({ totalContextTokens: 200, promptTokenCount: 199 }), 1);
  assert.equal(getDynamicMaxOutputTokens({ totalContextTokens: 200, promptTokenCount: 250 }), 1);
});

function parseRepoSearchPlannerAction(text: string) {
  return ModelJson.parseRepoSearchPlannerAction(text, { allowedToolNames: getRepoSearchToolNamesForParsing() });
}

test('ModelJson parses valid repo-search tool action', () => {
  const action = parseRepoSearchPlannerAction("{\"action\":\"repo_rg\",\"command\":\"rg planner src\"}");
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'repo_rg',
    args: { command: 'rg planner src' },
  });
});

test('ModelJson parses valid repo-search finish action', () => {
  const action = parseRepoSearchPlannerAction('{"action":"finish","output":"done"}');
  assert.deepEqual(action, {
    action: 'finish',
    output: 'done',
  });
});

test('ModelJson rejects repo-search finish confidence', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"finish","output":"done","confidence":0.7}'),
    /invalid planner finish action/u
  );
});

test('ModelJson rejects invalid repo-search planner payloads', () => {
  assert.throws(() => parseRepoSearchPlannerAction('not-json'), /invalid planner payload/u);
  assert.throws(
    () => parseRepoSearchPlannerAction("{\"action\":\"read_lines\",\"command\":\"rg x\"}"),
    /unknown planner action/u
  );
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"tool","tool_name":"run_repo_cmd","args":{"bad":"x"}}'),
    /unknown planner action/u
  );
});

test('ModelJson repairs malformed escaped command payloads', () => {
  const malformed = '{"action":"repo_rg","command":"rg -n \\"D:\\\\\\\\|C:\\\\\\\\|\\\\\\\\\\\\\\\\" src --type ts | Select-Object -First 30"';
  const action = parseRepoSearchPlannerAction(malformed);
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'repo_rg',
    args: { command: 'rg -n "D:\\\\|C:\\\\|\\\\\\\\" src --type ts | Select-Object -First 30' },
  });
});

test('isTransientProviderError treats ECONNREFUSED as transient', () => {
  assert.equal(isTransientProviderError(new Error('connect ECONNREFUSED 127.0.0.1:8097')), true);
});

test('retryProviderRequest retries transient failures and returns on success', async () => {
  let attemptCount = 0;
  const retryEvents: Array<{ attempt: number; nextDelayMs: number }> = [];
  const sleepCalls: number[] = [];
  const result = await retryProviderRequest(async () => {
    attemptCount += 1;
    if (attemptCount < 3) {
      const error = new Error(`connect ECONNREFUSED 127.0.0.1:8097 attempt=${attemptCount}`) as Error & { code?: string };
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return 'ok';
  }, {
    maxWaitMs: 5000,
    onRetry(event) {
      retryEvents.push({ attempt: event.attempt, nextDelayMs: event.nextDelayMs });
    },
    sleepMs: async (delayMs: number) => {
      sleepCalls.push(delayMs);
    },
  });
  assert.equal(result, 'ok');
  assert.equal(attemptCount, 3);
  assert.deepEqual(retryEvents.map((item) => item.attempt), [1, 2]);
  assert.deepEqual(sleepCalls, [250, 500]);
});

test('retryProviderRequest stops after max wait budget and surfaces the original error', async () => {
  let nowMs = 0;
  const retryEvents: number[] = [];
  await assert.rejects(
    () => retryProviderRequest(async () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:8097') as Error & { code?: string };
      error.code = 'ECONNREFUSED';
      throw error;
    }, {
      maxWaitMs: 200,
      onRetry(event) {
        retryEvents.push(event.attempt);
      },
      nowMs: () => nowMs,
      sleepMs: async (delayMs: number) => {
        nowMs += delayMs;
      },
    }),
    /ECONNREFUSED/u
  );
  assert.deepEqual(retryEvents, []);
});

test('runTaskLoop rewrites unsupported rg --type tsx and annotates output', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-tsx',
      question: 'Find tsx hits.',
      signals: ['tsx hit'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"foo\\\" --type tsx src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type ts': { exitCode: 0, stdout: 'tsx hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult?.command).startsWith('rg -n "foo" src --type ts'));
  assert.match(String(commandResult?.output || ''), /rewrote unsupported --type tsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop rewrites mixed rg --type ts and --type tsx flags', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-mixed-types',
      question: 'Find ts and tsx hits.',
      signals: ['mixed hit'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"foo\\\" --type ts --type tsx src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type ts': { exitCode: 0, stdout: 'mixed hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult?.command).startsWith('rg -n "foo" src --type ts'));
  assert.match(String(commandResult?.output || ''), /rewrote unsupported --type tsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop executes simple rg directly and preserves mixed quote regex', async () => {
  const repoRoot = createTempRepoRoot();
  fs.mkdirSync(path.join(repoRoot, 'src'));
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'example.ts'),
    'import { BridgeClient } from "../bridge/bridge.facade.js";\n',
    'utf8',
  );

  const result = await runTaskLoop(
    {
      id: 'task-direct-rg-mixed-quote',
      question: 'Find relative imports.',
      signals: ['BridgeClient'],
    },
    {
      repoRoot,
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:8097',
      includeRepoFileListing: false,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"from ['\\\\\\\"]\\\\.\\\\./\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
    }
  );

  assert.equal(result.commandFailures, 0);
  assert.match(result.commands[0]?.output || '', /BridgeClient/u);
  assert.equal(result.passed, true);
});

test('runTaskLoop rewrites rg --include and annotates output', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-include',
      question: 'Find imports.',
      signals: ['import hit'],
    },
    {
      repoRoot: process.cwd(),
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:8097',
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"from \\\" src --include \\\"*.ts\\\"\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "from " src --glob "*.ts"': { exitCode: 0, stdout: 'import hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult?.command || '').startsWith('rg -n "from " src --glob "*.ts"'));
  assert.match(String(commandResult?.output || ''), /rewrote unsupported rg --include to --glob/u);
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop counts rg syntax failures and gives planner guidance', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-rg-syntax-failure',
      question: 'Find imports.',
      signals: [],
    },
    {
      repoRoot: process.cwd(),
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:8097',
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"from \\\" src --bad-rg-flag\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "from " src --bad-rg-flag': { exitCode: 1, stdout: '', stderr: 'rg: unrecognized flag --bad-rg-flag' },
      },
    }
  );

  assert.equal(result.commandFailures, 1);
  assert.match(result.commands[0]?.output || '', /Command syntax failure; use a simpler rg command/u);
});

test('runTaskLoop reports prompt tokens and elapsed time on command progress events', async () => {
  const progressEvents: RepoSearchProgressEvent[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-progress-metadata',
      question: 'Find planner text.',
      signals: ['planner'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
      },
      onProgress(event: RepoSearchProgressEvent) {
        progressEvents.push(event);
      },
    }
  );

  const toolStart = progressEvents.find((event) => event.kind === 'tool_start');
  const toolResult = progressEvents.find((event) => event.kind === 'tool_result');
  assert.equal(typeof toolStart?.command, 'string');
  assert.equal(toolStart?.command, 'rg -n "planner" src');
  assert.equal(toolResult?.command, 'rg -n "planner" src');
  assert.equal(/--no-ignore|--ignore-case|--glob/u.test(String(toolResult?.command || '')), false);
  assert.equal(Number.isFinite(toolStart?.promptTokenCount), true);
  assert.equal(Number.isFinite(toolStart?.elapsedMs), true);
  assert.equal(Number(toolStart?.elapsedMs) >= 0, true);
  assert.equal(result.reason, 'finish');
  assert.equal(Number.isFinite(toolResult?.outputTokens), true);
  assert.equal(Number(toolResult?.outputTokens) > 0, true);
});

test('runTaskLoop tool_result outputTokens reflects the fitted bubble output', async () => {
  const longStdout = Array.from({ length: 400 }, (_, index) => `planner hit ${index}`).join('\n');
  const progressEvents: RepoSearchProgressEvent[] = [];
  await runTaskLoop(
    {
      id: 'task-output-tokens-full',
      question: 'Find planner text.',
      signals: ['planner'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 10000,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: longStdout, stderr: '' },
      },
      onProgress(event: RepoSearchProgressEvent) {
        progressEvents.push(event);
      },
    }
  );
  const toolResult = progressEvents.find((event) => event.kind === 'tool_result');
  assert.equal(Number(toolResult?.outputTokens) <= 600, true);
});

test('runTaskLoop logs fitted tool result truncation in the full inserted output', async () => {
  const longStdout = Array.from({ length: 400 }, (_, index) => `planner hit ${index}`).join('\n');
  const events: Record<string, unknown>[] = [];
  await runTaskLoop(
    {
      id: 'task-output-tokens-full-log',
      question: 'Find planner text.',
      signals: ['planner'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 10000,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: longStdout, stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );
  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.match(String(commandResult?.insertedResultText || ''), /truncated due to per-tool context limit/u);
});

test('runTaskLoop replaces long repeated tool output before inserting it into context', async () => {
  const repeatedTail = '</arg_value>'.repeat(10);
  const longStdout = `${Array.from({ length: 101 }, (_, index) => `src/example.ts:${index + 1}: anchor-${index}`).join('\n')}\n${repeatedTail}`;
  const progressEvents: RepoSearchProgressEvent[] = [];
  const events: Record<string, unknown>[] = [];

  await runTaskLoop(
    {
      id: 'task-output-loop-guard',
      question: 'Find planner text.',
      signals: ['planner'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 10000,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: longStdout, stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
      onProgress(event: RepoSearchProgressEvent) {
        progressEvents.push(event);
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  const toolResult = progressEvents.find((event) => event.kind === 'tool_result');
  assert.match(String(commandResult?.insertedResultText || ''), /SiftKit stopped tool output early/u);
  assert.doesNotMatch(String(commandResult?.insertedResultText || ''), new RegExp(repeatedTail, 'u'));
  assert.match(String(toolResult?.outputSnippet || ''), /SiftKit stopped tool output early/u);
  assert.doesNotMatch(String(toolResult?.outputSnippet || ''), new RegExp(repeatedTail, 'u'));
});

test('runTaskLoop does not replay final output as thinking progress', async () => {
  const progressEvents: RepoSearchProgressEvent[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-final-output-progress',
      question: 'Find planner text.',
      signals: ['planner'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"finish","output":"Duplicated answer body"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
      onProgress(event: RepoSearchProgressEvent) {
        progressEvents.push(event);
      },
    }
  );

  assert.equal(result.finalOutput, 'Duplicated answer body');
  assert.equal(
    progressEvents.some((event) => event.kind === 'thinking' && event.thinkingText === result.finalOutput),
    false
  );
});

test('runTaskLoop reuses preflight prompt token count for tool progress and allowance', async () => {
  const tokenizedContent: string[] = [];
  let chatRequestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/tokenize') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { content?: string };
        const content = String(parsed.content || '');
        tokenizedContent.push(content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.max(1, Math.ceil(content.length / 4)) }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      chatRequestCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: chatRequestCount === 1
              ? "{\"action\":\"repo_git\",\"command\":\"git status --short\"}"
              : '{"action":"finish","output":"done"}',
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number(typeof address === 'object' && address ? address.port : 0)}`;

  try {
    const result = await runTaskLoop(
      {
        id: 'task-reuse-preflight-prompt-tokens',
        question: 'Find git status.',
        signals: [],
      },
      {
        repoRoot: process.cwd(),
        baseUrl,
        model: 'mock-model',
        config: mockConfig({
          Runtime: {
            Model: 'mock-model',
            LlamaCpp: { BaseUrl: baseUrl, NumCtx: 128000 },
          },
        }),
        totalContextTokens: 128000,
        maxTurns: 2,
        minToolCallsBeforeFinish: 0,
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: ' M src/repo-search/engine.ts', stderr: '' },
        },
      }
    );

    assert.equal(result.reason, 'finish');
    const promptTokenizations = tokenizedContent.filter((content) => content.includes('You are a repo-search planner.'));
    const uniquePromptTokenizations = new Set(promptTokenizations);
    assert.equal(promptTokenizations.length, uniquePromptTokenizations.size);
    const formattedResultTokenizations = tokenizedContent.filter(
      (content) => content === 'M src/repo-search/engine.ts'
    );
    assert.equal(formattedResultTokenizations.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runTaskLoop executes repo_list_files and repo_read_file natively', async () => {
  const events: Record<string, unknown>[] = [];
  const repoRoot = createTempRepoRoot();
  try {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'sample.ts'), 'line-1\nline-2\nline-3\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'other.ts'), 'other-line\n', 'utf8');

    const result = await runTaskLoop(
      {
        id: 'task-native-read-list',
        question: 'List files, then read the sample file.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        repoRoot,
        maxTurns: 3,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          "{\"action\":\"repo_list_files\",\"path\":\"src\",\"glob\":\"*.ts\",\"recurse\":true}",
          "{\"action\":\"repo_read_file\",\"path\":\"src/sample.ts\",\"startLine\":2,\"endLine\":3}",
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {},
        logger: {
          path: 'memory',
          write(event: Record<string, unknown>) {
            events.push(event);
          },
        },
      }
    );

    const commandResults = events.filter((event) => event.kind === 'turn_command_result');
    assert.equal(commandResults.length >= 2, true);
    assert.match(String(commandResults[0]?.command || ''), /^repo_list_files/u);
    assert.match(String(commandResults[0]?.insertedResultText || ''), /src[\\/]other\.ts/u);
    assert.match(String(commandResults[1]?.command || ''), /^repo_read_file/u);
    assert.match(String(commandResults[1]?.insertedResultText || ''), /2: line-2/u);
    assert.match(String(commandResults[1]?.insertedResultText || ''), /3: line-3/u);
    assert.equal(result.reason, 'finish');
    assert.equal(result.commandFailures, 0);
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runTaskLoop executes repo_list_files at repository root natively', async () => {
  const events: Record<string, unknown>[] = [];
  const repoRoot = createTempRepoRoot();
  try {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'root readme\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'sample.ts'), 'sample\n', 'utf8');

    const result = await runTaskLoop(
      {
        id: 'task-native-root-list',
        question: 'List repository root files.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          "{\"action\":\"repo_list_files\",\"path\":\".\",\"recurse\":false}",
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {},
        logger: {
          path: 'memory',
          write(event: Record<string, unknown>) {
            events.push(event);
          },
        },
      }
    );

    const commandResults = events.filter((event) => event.kind === 'turn_command_result');
    const output = String(commandResults[0]?.insertedResultText || '');
    assert.match(String(commandResults[0]?.command || ''), /^repo_list_files/u);
    assert.match(output, /README\.md/u);
    assert.equal(result.commandFailures, 0);
    assert.equal(result.safetyRejects, 0);
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runTaskLoop executes repo_list_files with runner-* glob natively', async () => {
  const events: Record<string, unknown>[] = [];
  const repoRoot = createTempRepoRoot();
  try {
    fs.mkdirSync(path.join(repoRoot, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'logs', 'runner-20260425.ndjson'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'logs', 'runner.sqlite3'), '', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'logs', 'not-runner.txt'), 'ignored\n', 'utf8');

    const result = await runTaskLoop(
      {
        id: 'task-runner-glob',
        question: 'List runner files.',
        signals: ['done'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          "{\"action\":\"repo_list_files\",\"path\":\"logs\",\"glob\":\"runner-*\",\"recurse\":true}",
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {},
        logger: {
          path: 'memory',
          write(event: Record<string, unknown>) {
            events.push(event);
          },
        },
      }
    );

    const commandResults = events.filter((event) => event.kind === 'turn_command_result');
    const output = String(commandResults[0]?.insertedResultText || '');
    assert.match(String(commandResults[0]?.command || ''), /^repo_list_files/u);
    assert.match(output, /logs[\\/]runner-20260425\.ndjson/u);
    assert.doesNotMatch(output, /runner\.sqlite3/u);
    assert.doesNotMatch(output, /not-runner\.txt/u);
    assert.equal(result.reason, 'finish');
    assert.equal(result.commandFailures, 0);
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runTaskLoop logs provider request error details and surfaces enriched network failures', async () => {
  const events: Record<string, unknown>[] = [];
  const startedAt = Date.now();
  await assert.rejects(
    () => runTaskLoop(
      {
        id: 'task-provider-network-error',
        question: 'Trigger a provider request failure.',
        signals: [],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        baseUrl: 'http://127.0.0.1:1',
        model: 'mock-model',
        timeoutMs: 500,
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        logger: {
          path: 'memory',
          write(event: Record<string, unknown>) {
            events.push(event);
          },
        },
      }
    ),
    /provider request failed stage=planner_action/u
  );
  assert.equal(Date.now() - startedAt < 2_000, true);

  const startEvent = events.find((event) => event.kind === 'provider_request_start');
  assert.equal(startEvent?.stage, 'planner_action');
  assert.equal(startEvent?.method, 'POST');
  assert.equal(startEvent?.path, '/v1/chat/completions');

  const errorEvent = events.find((event) => event.kind === 'provider_request_error');
  assert.equal(errorEvent?.stage, 'planner_action');
  assert.equal(typeof errorEvent?.elapsedMs, 'number');
  assert.equal(Number(errorEvent?.elapsedMs) >= 0, true);
  assert.equal(typeof errorEvent?.error, 'object');
  assert.equal(typeof (errorEvent?.error as { message?: unknown } | undefined)?.message, 'string');
});

test('runTaskLoop rewrites unsupported rg --type tsx even when --glob is present', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-with-glob',
      question: 'Find tsx hits.',
      signals: ['tsx glob hit'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"foo\\\" --type tsx --glob \\\"*.tsx\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" --glob "*.tsx" src --type ts': { exitCode: 0, stdout: 'tsx glob hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult?.command).startsWith('rg -n "foo" --glob "*.tsx" src --type ts'));
  assert.match(String(commandResult?.output || ''), /rewrote unsupported --type tsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
});

test('runTaskLoop rewrites unsupported rg --type jsx to --type js', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-jsx',
      question: 'Find jsx hits.',
      signals: ['jsx hit'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"foo\\\" --type jsx src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type js': { exitCode: 0, stdout: 'jsx hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult?.command).startsWith('rg -n "foo" src --type js'));
  assert.match(String(commandResult?.output || ''), /rewrote unsupported --type jsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop rewrites mixed --type jsx and --type tsx to --type js and --type ts', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-jsx-tsx',
      question: 'Find jsx and tsx hits.',
      signals: ['both hit'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"foo\\\" --type jsx --type tsx src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type js --type ts': { exitCode: 0, stdout: 'both hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult?.command).startsWith('rg -n "foo" src --type js --type ts'));
  assert.match(String(commandResult?.output || ''), /rewrote unsupported --type jsx, tsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop counts non-zero command exits as command failures but not invalid responses', async () => {
  const task = await runTaskLoop(
    {
      id: 'task-command-failure',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 2, stdout: '', stderr: 'boom' },
      },
    }
  );

  assert.equal(task.invalidResponses, 0);
  assert.equal(task.commandFailures, 1);
  assert.equal(task.passed, false);

  const scorecard = buildScorecard({
    runId: 'run-command-failure',
    model: 'model-x',
    tasks: [task],
  });
  assert.equal(scorecard.totals.commandFailures, 1);
  assert.equal(scorecard.verdict, 'fail');
});

test('runTaskLoop does not count rg exit code 1 (no matches) as a command failure', async () => {
  const task = await runTaskLoop(
    {
      id: 'task-rg-no-match',
      question: 'Find better-sqlite3 usage.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"better-sqlite3\\\" src --type ts\"}",
        '{"action":"finish","output":"no matches found"}',
        '{"verdict":"pass","reason":"valid no-results answer"}',
      ],
      mockCommandResults: {
        'rg -n "better-sqlite3" src --type ts': { exitCode: 1, stdout: '', stderr: '' },
      },
    }
  );

  assert.equal(task.commandFailures, 0);
  assert.equal(task.passed, true);
});

test('runTaskLoop does not count grep exit code 1 (no matches) as a command failure', async () => {
  const task = await runTaskLoop(
    {
      id: 'task-grep-no-match',
      question: 'Find TODO comments.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_grep\",\"command\":\"grep -rn \\\"TODO\\\" src\"}",
        '{"action":"finish","output":"no TODOs found"}',
        '{"verdict":"pass","reason":"valid no-results answer"}',
      ],
      mockCommandResults: {
        'grep -rn "TODO" src': { exitCode: 1, stdout: '', stderr: '' },
      },
    }
  );

  assert.equal(task.commandFailures, 0);
  assert.equal(task.passed, true);
});

test('runTaskLoop still counts exit code 1 from non-search commands as a command failure', async () => {
  const task = await runTaskLoop(
    {
      id: 'task-non-search-exit1',
      question: 'Check git log.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_git\",\"command\":\"git log --oneline\"}",
        '{"action":"finish","output":"failed"}',
        '{"verdict":"pass","reason":"ok"}',
      ],
      mockCommandResults: {
        'git log --oneline': { exitCode: 1, stdout: '', stderr: 'error' },
      },
    }
  );

  assert.equal(task.commandFailures, 1);
  assert.equal(task.passed, false);
});

test('runTaskLoop stops on finish action', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-finish',
      question: 'Find planner tool names.',
      signals: ['find_text', 'read_lines', 'json_filter'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 10,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"finish","output":"find_text read_lines json_filter"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.turnsUsed, 1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop executes tool batches sequentially and counts each tool call toward finish depth', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-tool-batch',
      question: 'Find planner prompt and prompt budget helpers.',
      signals: ['planner prompt', 'prompt budget'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 2,
      mockResponses: [
        JSON.stringify({
          action: 'tool_batch',
          calls: [
            { action: 'repo_rg', command: 'rg -n "planner prompt" src' },
            { action: 'repo_rg', command: 'rg -n "prompt budget" src' },
          ],
        }),
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner prompt" src': {
          exitCode: 0,
          stdout: 'src/repo-search/prompts.ts:228:repo-search planner prompt',
          stderr: '',
        },
        'rg -n "prompt budget" src': {
          exitCode: 0,
          stdout: 'src/repo-search/prompt-budget.ts:1:prompt budget helper',
          stderr: '',
        },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.turnsUsed, 2);
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].command.startsWith('rg -n "planner prompt" src'), true);
  assert.equal(result.commands[1].command.startsWith('rg -n "prompt budget" src'), true);
});

test('runTaskLoop accepts corroborated finish before minimum tool-call depth', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-min-depth',
      question: 'Find planner tools.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 2,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        "{\"action\":\"repo_get_content\",\"command\":\"Get-Content src\\\\summary.ts | Select-Object -First 20\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'src\\summary.ts:10:planner hit', stderr: '' },
        'Get-Content src\\summary.ts | Select-Object -First 20': { exitCode: 0, stdout: '10: planner hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 2);
  assert.equal(result.finalOutput, 'done');
  assert.equal(events.some((event) => event.kind === 'turn_finish_rejected'), false);
});

test('runTaskLoop stops at max turns when model keeps asking for tools', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-max-turns',
      question: 'Find planner prompt location.',
      signals: ['summary.ts'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 3,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"buildPlannerPrompt\\\" src\\\\summary.ts\"}",
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"buildPlannerPrompt\\\" src\\\\summary.ts\"}",
        'Synthesized best-effort answer referencing src\\summary.ts:907.',
      ],
      mockCommandResults: {
        'rg -n "buildPlannerPrompt" src\\summary.ts': {
          exitCode: 0,
          stdout: '907:function buildPlannerPrompt(options: {',
          stderr: '',
        },
      },
    }
  );

  assert.equal(result.reason, 'max_turns');
  assert.equal(result.turnsUsed, 2);
  assert.equal(result.commands.length, 2);
  assert.equal(result.finalOutput, 'Synthesized best-effort answer referencing src\\summary.ts:907.');
});

test('runTaskLoop prompt omits visible tool-call budget counters', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-budget-hidden',
      question: 'Track tool usage.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"summary\\\" src\"}",
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
        'rg -n "summary" src': { exitCode: 0, stdout: 'summary hit', stderr: '' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const turnNewMessagesEvents = events.filter((event) => event.kind === 'turn_new_messages');
  assert.equal(turnNewMessagesEvents.length >= 3, true);
  const allMessageContent = turnNewMessagesEvents
    .flatMap((event) => Array.isArray(event.messages) ? event.messages as Array<{ content?: unknown }> : [])
    .map((m) => String(m.content || ''))
    .join('\n');
  assert.doesNotMatch(allMessageContent, /Tool-call budget remaining:/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop prompt includes anti-loop and larger single-file read guidance', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-prompt-single-file-guidance',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: ['{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const systemMessage = (events.find((event) => event.kind === 'turn_new_messages' && event.turn === 1)?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.find((m) => m.role === 'system')?.content || '';
  const prompt = String(systemMessage);
  // Substance: anchor-first read flow, larger windows over tiny slices, recovery on token-budget errors.
  assert.match(prompt, /Anchor-before-read/u);
  assert.match(prompt, /rg.*anchor|anchor.*rg/iu);
  assert.match(prompt, /repo_read_file/u);
  assert.match(prompt, /one large window per anchor|larger window/u);
  assert.match(prompt, /never tiny|tiny-slice/u);
  assert.match(prompt, /Two reads of the same file must have an `rg` search between them/u);
  assert.match(prompt, /strengthen the anchor/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop prompt examples use larger reads and anchor-first flow', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-prompt-example-guidance',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: ['{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const systemMessage2 = (events.find((event) => event.kind === 'turn_new_messages' && event.turn === 1)?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.find((m) => m.role === 'system')?.content || '';
  const prompt = String(systemMessage2);
  assert.doesNotMatch(prompt, /Get-Content src\\\\summary\.ts/u);
  assert.match(prompt, /repo_list_files/u);
  assert.match(prompt, /rg -n \\"invokePlannerMode\\"/u);
  assert.match(prompt, /repo_read_file/u);
  assert.match(prompt, /"path":"dir\\\\foo\.ts","startLine":861,"endLine":1100/u);
  assert.match(prompt, /tiny-slice/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop records line-read stats for Get-Content windows', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-line-read-stats',
      question: 'Read a file section.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_get_content\",\"command\":\"Get-Content src\\\\summary.ts | Select-Object -Skip 40 -First 6\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'Get-Content src\\summary.ts | Select-Object -Skip 40 -First 6': {
          exitCode: 0,
          stdout: ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'),
          stderr: '',
        },
      },
    }
  );

  assert.equal(result.toolStats['get-content'].lineReadCalls, 1);
  assert.equal(result.toolStats['get-content'].lineReadLinesTotal, 6);
  assert.ok(Number(result.toolStats['get-content'].lineReadTokensTotal) > 0);
});

test('runTaskLoop prompt states ignored paths are auto-filtered by runtime policy', async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-prompt-ignore-policy',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: ['{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, unknown>) {
          events.push(event);
        },
      },
    }
  );

  const systemMessage3 = (events.find((event) => event.kind === 'turn_new_messages' && event.turn === 1)?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.find((m) => m.role === 'system')?.content || '';
  assert.match(String(systemMessage3), /Ignored paths are auto-filtered by runtime policy/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop rewrites Get-ChildItem recurse command to include ignore excludes', async () => {
  const events: Record<string, unknown>[] = [];
  const repoRoot = createTempRepoRoot('/custom_ignored\n');
  try {
    const result = await runTaskLoop(
      {
        id: 'task-ignore-get-childitem',
        question: 'List source files.',
        signals: ['listed'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          "{\"action\":\"repo_get_childitem\",\"command\":\"Get-ChildItem src -Recurse -Filter *.ts\"}",
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {
          'Get-ChildItem src -Recurse -Filter *.ts': {
            exitCode: 0,
            stdout: 'listed',
            stderr: '',
          },
        },
        logger: {
          path: 'memory',
          write(event: Record<string, unknown>) {
            events.push(event);
          },
        },
      }
    );

    const commandResult = events.find((event) => event.kind === 'turn_command_result');
    assert.ok(
      String(commandResult?.command).startsWith('Get-ChildItem src -Recurse -Filter *.ts -Exclude ')
    );
    assert.match(String(commandResult?.command), /node_modules/u);
    assert.match(String(commandResult?.output || ''), /added -Exclude from ignore policy/u);
    assert.equal(result.reason, 'finish');
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runTaskLoop rewrites Select-String path scan to include ignore excludes', async () => {
  const events: Record<string, unknown>[] = [];
  const repoRoot = createTempRepoRoot('/custom_ignored\n');
  try {
    const result = await runTaskLoop(
      {
        id: 'task-ignore-select-string',
        question: 'Find planner text.',
        signals: ['hit'],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          "{\"action\":\"repo_select_string\",\"command\":\"Select-String -Path \\\"src\\\\*.ts\\\" -Pattern \\\"planner\\\"\"}",
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {
          'Select-String -Path "src\\*.ts" -Pattern "planner"': {
            exitCode: 0,
            stdout: 'hit',
            stderr: '',
          },
        },
        logger: {
          path: 'memory',
          write(event: Record<string, unknown>) {
            events.push(event);
          },
        },
      }
    );

    const commandResult = events.find((event) => event.kind === 'turn_command_result');
    assert.ok(
      String(commandResult?.command).startsWith('Select-String -Path "src\\*.ts" -Pattern "planner" -Exclude ')
    );
    assert.match(String(commandResult?.command), /node_modules/u);
    assert.match(String(commandResult?.output || ''), /added -Exclude from ignore policy/u);
    assert.equal(result.reason, 'finish');
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runTaskLoop allows rg commands that include --no-ignore explicitly', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-ignore-rg-no-ignore',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src --no-ignore\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].safe, true);
  assert.equal(result.commands[0].reason, null);
  assert.match(String(result.commands[0].output || ''), /ran 'rg -n "planner" src --no-ignore/u);
  assert.doesNotMatch(String(result.commands[0].output || ''), /--no-ignore --no-ignore/u);
});

test('runTaskLoop allows rg commands that include -u explicitly', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-ignore-rg-u',
      question: 'Find planner text.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"repo_rg","command":"rg -n \\"planner\\" src -u"}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].safe, true);
  assert.equal(result.commands[0].reason, null);
  assert.match(String(result.commands[0].output || ''), /ran 'rg -n "planner" src -u/u);
  assert.doesNotMatch(String(result.commands[0].output || ''), /src -u --no-ignore/u);
});

test('runTaskLoop rejects Get-Content reads under ignored directories', async () => {
  const repoRoot = createTempRepoRoot('');
  try {
    const result = await runTaskLoop(
      {
        id: 'task-ignore-get-content',
        question: 'Read ignored file.',
        signals: [],
      },
      {
        ...MOCK_LOOP_DEFAULTS,
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          "{\"action\":\"repo_get_content\",\"command\":\"Get-Content node_modules\\\\leftpad\\\\index.js\"}",
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {},
      }
    );

    assert.equal(result.reason, 'finish');
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].safe, false);
    assert.equal(result.commands[0].reason, 'command targets a path ignored by policy');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runTaskLoop sends append-only chat requests with explicit cache_prompt and a pinned slot', async () => {
  const chatRequests: Record<string, unknown>[] = [];
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/tokenize') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const content = String(parsed.content || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.max(1, Math.ceil(content.length / 4)) }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requestCount += 1;
        const parsed = JSON.parse(body || '{}');
        chatRequests.push(parsed);
        const content = requestCount === 1
          ? JSON.stringify({
            action: 'repo_rg',
            command: 'rg -n "planner" src',
          })
          : JSON.stringify({
            action: 'finish',
            output: 'done',
          });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number((address as AddressInfo).port)}`;

  try {
    const result = await runTaskLoop(
      {
        id: 'task-chat-transcript',
        question: 'Find planner text.',
        signals: [],
      },
      {
        repoRoot: process.cwd(),
        baseUrl,
        model: 'mock-model',
        config: mockConfig({
          Runtime: {
            Model: 'mock-model',
            LlamaCpp: {
              BaseUrl: baseUrl,
              NumCtx: 70000,
              ParallelSlots: 4,
              Reasoning: 'off',
            },
          },
        }),
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockCommandResults: {
          'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
        },
      }
    );

    assert.equal(result.reason, 'finish');
    assert.equal(chatRequests.length, 2);
    assert.equal(chatRequests[0].cache_prompt, true);
    assert.equal(chatRequests[1].cache_prompt, true);
    assert.equal(Number.isInteger(chatRequests[0].id_slot), true);
    assert.equal(chatRequests[0].id_slot, chatRequests[1].id_slot);
    assert.equal((chatRequests[0]?.response_format as { type?: unknown } | undefined)?.type, 'json_schema');
    assert.equal('tools' in chatRequests[0], false);
    assert.equal('parallel_tool_calls' in chatRequests[0], false);
    assert.equal((chatRequests[1].messages as unknown[]).length > (chatRequests[0].messages as unknown[]).length, true);
    assert.doesNotMatch(JSON.stringify(chatRequests[0].messages), /Tool-call budget remaining:/u);
    assert.doesNotMatch(JSON.stringify(chatRequests[1].messages), /Tool-call budget remaining:/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runTaskLoop keeps one duplicate warning tool turn and forces finish on the fifth duplicate', async () => {
  const chatRequests: Record<string, unknown>[] = [];
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/tokenize') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const content = String(parsed.content || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.max(1, Math.ceil(content.length / 4)) }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requestCount += 1;
        const parsed = JSON.parse(body || '{}');
        chatRequests.push(parsed);
        const content = requestCount <= 5
          ? JSON.stringify({
            action: 'repo_rg',
            command: 'rg -n "planner" src',
          })
          : JSON.stringify({
            action: 'finish',
            output: 'done',
          });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number((address as AddressInfo).port)}`;

  try {
    const result = await runTaskLoop(
      {
        id: 'task-duplicate-warning-tool-turn',
        question: 'Find planner text.',
        signals: [],
      },
      {
        repoRoot: process.cwd(),
        baseUrl,
        model: 'mock-model',
        config: mockConfig({
          Runtime: {
            Model: 'mock-model',
            LlamaCpp: {
              BaseUrl: baseUrl,
              NumCtx: 70000,
              ParallelSlots: 4,
              Reasoning: 'off',
            },
          },
        }),
        maxTurns: 6,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockCommandResults: {
          'rg -n "planner" src': { exitCode: 0, stdout: 'src\\planner.ts:10: planner hit', stderr: '' },
        },
      }
    );

    assert.equal(result.reason, 'finish');
    assert.equal(chatRequests.length, 6);
    const finalMessages = Array.isArray(chatRequests[5]?.messages) ? chatRequests[5].messages : [];
    const assistantToolCalls = finalMessages.filter((message) => Array.isArray(message?.tool_calls));
    const toolMessages = finalMessages.filter((message) => message?.role === 'tool');
    const duplicateToolMessages = toolMessages.filter((message) => /duplicate command requested/u.test(String(message?.content || '')));
    const duplicateUserMessages = finalMessages.filter((message) => message?.role === 'user' && /duplicate command requested/u.test(String(message?.content || '')));
    assert.equal(assistantToolCalls.length, 2);
    assert.equal(toolMessages.length, 2);
    assert.equal(duplicateToolMessages.length, 1);
    assert.equal(duplicateUserMessages.length, 0);
    assert.match(String(duplicateToolMessages[0]?.content || ''), /duplicate command requested x5\. Issue a different\/unique tool call/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runTaskLoop synthesizes final output on terminal max_turns', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-max-turns-synthesis',
      question: 'Find planner prompt location.',
      signals: [],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 3,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"buildPlannerPrompt\\\" src\\\\summary.ts\"}",
        'best-effort answer with evidence',
      ],
      mockCommandResults: {
        'rg -n "buildPlannerPrompt" src\\summary.ts': {
          exitCode: 0,
          stdout: '907:function buildPlannerPrompt(options: {',
          stderr: '',
        },
      },
    }
  );

  assert.equal(result.reason, 'max_turns');
  assert.equal(result.finalOutput, 'best-effort answer with evidence');
});

test('runTaskLoop uses dynamic max_tokens for planner requests from live prompt budget', async () => {
  const chatRequests: Array<Record<string, unknown>> = [];
  const loggedPromptTokenCounts: number[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        chatRequests.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"action":"finish","output":"done"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number(typeof address === 'object' && address ? address.port : 0)}`;

  try {
    const result = await runTaskLoop(
      {
        id: 'task-dynamic-planner-max-tokens',
        question: 'Find planner prompt location.',
        signals: [],
      },
      {
        repoRoot: process.cwd(),
        baseUrl,
        model: 'mock-model',
        totalContextTokens: 20000,
        maxTurns: 1,
        minToolCallsBeforeFinish: 0,
        includeRepoFileListing: false,
        logger: {
          path: 'test',
          write(event: Record<string, unknown>) {
            if (event.kind === 'turn_preflight_budget' && Number.isFinite(event.promptTokenCount)) {
              loggedPromptTokenCounts.push(Number(event.promptTokenCount));
            }
          },
        },
      }
    );

    assert.equal(result.reason, 'finish');
    assert.equal(chatRequests.length, 1);
    assert.equal(loggedPromptTokenCounts.length, 1);
    assert.equal(
      Number(chatRequests[0].max_tokens),
      getDynamicMaxOutputTokens({ totalContextTokens: 20000, promptTokenCount: loggedPromptTokenCounts[0] })
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runTaskLoop uses dynamic max_tokens for terminal synthesis requests', async () => {
  const chatRequests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        chatRequests.push(parsed);
        const isTerminalSynthesis = String(parsed?.response_format?.type || '') !== 'json_schema';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: isTerminalSynthesis ? 'best-effort answer' : 'not-json',
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number(typeof address === 'object' && address ? address.port : 0)}`;

  try {
    const result = await runTaskLoop(
      {
        id: 'task-dynamic-terminal-synthesis-max-tokens',
        question: 'Find planner prompt location.',
        signals: [],
      },
      {
        repoRoot: process.cwd(),
        baseUrl,
        model: 'mock-model',
        totalContextTokens: 12000,
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        includeRepoFileListing: false,
      }
    );

    assert.equal(result.reason, 'invalid_response_limit');
    assert.equal(result.finalOutput, 'best-effort answer');
    assert.equal(chatRequests.length, 2);
    const synthesisPrompt = String((chatRequests[1].messages as Array<Record<string, unknown>>)?.[0]?.content || '');
    assert.equal(
      Number(chatRequests[1].max_tokens),
      getDynamicMaxOutputTokens({
        totalContextTokens: 12000,
        promptTokenCount: Math.max(1, Math.ceil(synthesisPrompt.length / 4)),
      })
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runTaskLoop assigns a unique toolCallId pairing tool_start with tool_result', async () => {
  const progressEvents: RepoSearchProgressEvent[] = [];
  await runTaskLoop(
    {
      id: 'task-tool-call-id',
      question: 'Find planner text.',
      signals: ['planner'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
        "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"prompt\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
        'rg -n "prompt" src': { exitCode: 0, stdout: 'prompt hit', stderr: '' },
      },
      onProgress(event: RepoSearchProgressEvent) {
        progressEvents.push(event);
      },
    }
  );

  const starts = progressEvents.filter((event) => event.kind === 'tool_start');
  const results = progressEvents.filter((event) => event.kind === 'tool_result');
  assert.equal(starts.length, 2);
  assert.equal(results.length, 2);
  for (let index = 0; index < starts.length; index += 1) {
    assert.equal(typeof starts[index].toolCallId, 'string');
    assert.equal(String(starts[index].toolCallId).length > 0, true);
    assert.equal(starts[index].toolCallId, results[index].toolCallId);
  }
  assert.notEqual(starts[0].toolCallId, starts[1].toolCallId);
});

