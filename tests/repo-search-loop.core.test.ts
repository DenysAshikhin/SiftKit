import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { asObject, asArray, asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';

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
import { getDefaultConfigObject } from '../src/config/defaults.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockSiftConfig } from './helpers/mock-config.js';

// Mock-mode runTaskLoop calls do not reach a real provider or repo; these defaults
// satisfy the required RunTaskLoopOptions fields with an empty repo root (behaviour-
// equivalent to the values previously omitted while the file was untyped).
const MOCK_LOOP_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-mock-loop-'));
const MOCK_LOOP_DEFAULTS = {
  repoRoot: MOCK_LOOP_REPO_ROOT,
  model: 'mock-model',
  baseUrl: 'http://127.0.0.1:1',
};

// These mock-mode loops read only Runtime.LlamaCpp. Build a real default config
// and override those fields so the value is fully typed (no casts).
function mockConfig(overrides: {
  Runtime: { LlamaCpp: Partial<SiftConfig['Runtime']['LlamaCpp']> };
}): SiftConfig {
  const base = getDefaultConfigObject();
  return {
    ...base,
    Runtime: {
      ...base.Runtime,
      LlamaCpp: { ...base.Runtime.LlamaCpp, ...overrides.Runtime.LlamaCpp },
    },
  };
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

// F14 (test-pyramid rebalance): pure-function decisions previously co-located here were
// relocated to their seams (command-safety, model-json, provider-helpers, dynamic-output-cap,
// repo-search-prompts). The remaining runTaskLoop cases are intentionally retained as E2E
// integration coverage: each exercises engine orchestration branches (native-tool dispatch,
// in-loop tool-result budgeting, finish-depth/duplicate/forced-finish governance, live
// max_tokens injection, append-only transcript wiring, progress-event plumbing) that the
// coverage-attribution harness proved are not redundant with any sibling case (residual > 0).
// The unit-level decisions they build on are covered directly in engine-native-tools,
// engine-tool-result-budgeter, tool-loop-governor, engine-forced-finish, engine-duplicate-tracker,
// engine-token-usage, and engine-transcript-manager seams.

test('assertConfiguredModelPresent hard-fails when configured model is missing', () => {
  assert.throws(
    () => assertConfiguredModelPresent('Qwen3.5-9B-Q8_0.gguf', ['Qwen3.5-27B-Q4_K_M.gguf']),
    /Configured model not found/u
  );
});

test('runRepoSearch does not fail on model inventory mismatch', async () => {
  const scorecard = await runRepoSearch({
    config: mockSiftConfig({
      Runtime: {
        LlamaCpp: {
          BaseUrl: 'http://127.0.0.1:8097',
          NumCtx: 70000,
        },
      },
    }),
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
  const events: JsonObject[] = [];
  const scorecard = await runRepoSearch({
    config: mockSiftConfig({
      Runtime: { LlamaCpp: { BaseUrl: 'http://127.0.0.1:8097', NumCtx: 70000 } },
      WebSearch: {
        EnabledDefault: true,
        Providers: { tavily: { Enabled: true, ApiKey: 'test-key' }, firecrawl: { Enabled: false, ApiKey: '' } },
        ProviderOrder: ['tavily', 'firecrawl'],
        ResultCount: 5,
        FetchMaxPages: 3,
        TimeoutMs: 15000,
        FetchMaxCharacters: 12000,
      },
    }),
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

test('runTaskLoop rewrites mixed rg --type ts and --type tsx flags', async () => {
  const events: JsonObject[] = [];
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
        write(event) {
          events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];
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
        write(event) {
          events.push(JSON.parse(JSON.stringify(event)));
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

// F14: retained E2E — branches subset another case, but this uniquely asserts tool_start/
// tool_result progress-event token/elapsed plumbing and original-command preservation.
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
  const events: JsonObject[] = [];
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
        write(event) {
          events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];

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
        write(event) {
          events.push(JSON.parse(JSON.stringify(event)));
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
        const parsed = asObject(parseJsonValueText(body || '{}'));
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
  const events: JsonObject[] = [];
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
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];
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
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];
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
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];
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
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
  assert.equal(typeof asObject(errorEvent?.error).message, 'string');
});

test('runTaskLoop rewrites mixed --type jsx and --type tsx to --type js and --type ts', async () => {
  const events: JsonObject[] = [];
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
        write(event) {
          events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];
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
        write(event) {
          events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];
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
        write(event) {
          events.push(JSON.parse(JSON.stringify(event)));
        },
      },
    }
  );

  const turnNewMessagesEvents = events.filter((event) => event.kind === 'turn_new_messages');
  assert.equal(turnNewMessagesEvents.length >= 3, true);
  const allMessageContent = turnNewMessagesEvents
    .flatMap((event) => asObjectArray(event.messages))
    .map((m) => String(m.content || ''))
    .join('\n');
  assert.doesNotMatch(allMessageContent, /Tool-call budget remaining:/u);
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

test('runTaskLoop rewrites Get-ChildItem recurse command to include ignore excludes', async () => {
  const events: JsonObject[] = [];
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
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
  const events: JsonObject[] = [];
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
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
  const chatRequests: JsonObject[] = [];
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
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

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
    assert.equal(asObject(chatRequests[0]?.response_format).type, 'json_schema');
    assert.equal('tools' in chatRequests[0], false);
    assert.equal('parallel_tool_calls' in chatRequests[0], false);
    assert.equal(asArray(chatRequests[1].messages).length > asArray(chatRequests[0].messages).length, true);
    assert.doesNotMatch(JSON.stringify(chatRequests[0].messages), /Tool-call budget remaining:/u);
    assert.doesNotMatch(JSON.stringify(chatRequests[1].messages), /Tool-call budget remaining:/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runTaskLoop keeps one duplicate warning tool turn and forces finish on the fifth duplicate', async () => {
  const chatRequests: JsonObject[] = [];
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
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

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
    const finalMessages = asObjectArray(chatRequests[5]?.messages);
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
  const chatRequests: JsonObject[] = [];
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
          write(event) {
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
  const chatRequests: JsonObject[] = [];
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
    const synthesisPrompt = String(asObject(asObjectArray(chatRequests[1].messages)[0]).content || '');
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

