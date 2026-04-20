// @ts-nocheck — Full type-checking deferred; script uses @ts-nocheck internally.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parsePlannerAction } from '../src/repo-search/planner-protocol.js';
import { evaluateCommandSafety } from '../src/repo-search/command-safety.js';
import { isTransientProviderError, retryProviderRequest } from '../src/lib/provider-helpers.js';
import {
  runTaskLoop,
  buildScorecard,
  assertConfiguredModelPresent,
  runRepoSearch,
  resolveRepoSearchRequestMaxTokens,
} from '../src/repo-search/engine.js';
import { buildTaskSystemPrompt } from '../src/repo-search/prompts.js';
import {
  preflightPlannerPromptBudget,
  compactPlannerMessagesOnce,
} from '../src/repo-search/prompt-budget.js';

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

test('resolveRepoSearchRequestMaxTokens reuses one cap source for repo-search requests', () => {
  assert.equal(resolveRepoSearchRequestMaxTokens({}), 2048);
  assert.equal(resolveRepoSearchRequestMaxTokens({ requestMaxTokens: 1025.9 }), 1025);
  assert.equal(resolveRepoSearchRequestMaxTokens({
    config: {
      Runtime: {
        LlamaCpp: {
          MaxTokens: 1536,
        },
      },
    },
  }), 1536);
  assert.equal(resolveRepoSearchRequestMaxTokens({
    config: {
      Runtime: {
        LlamaCpp: {
          MaxTokens: 15000,
        },
      },
    },
  }), 2048);
});

test('parsePlannerAction parses valid tool action', () => {
  const action = parsePlannerAction('{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg planner src"}}');
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'repo_rg',
    args: { command: 'rg planner src' },
  });
});

test('parsePlannerAction parses valid finish action', () => {
  const action = parsePlannerAction('{"action":"finish","output":"done","confidence":0.7}');
  assert.deepEqual(action, {
    action: 'finish',
    output: 'done',
    confidence: 0.7,
  });
});

test('parsePlannerAction rejects invalid payloads', () => {
  assert.throws(() => parsePlannerAction('not-json'), /invalid planner payload/u);
  assert.throws(
    () => parsePlannerAction('{"action":"tool","tool_name":"read_lines","args":{"command":"rg x"}}'),
    /invalid planner tool action/u
  );
  assert.throws(
    () => parsePlannerAction('{"action":"tool","tool_name":"run_repo_cmd","args":{"bad":"x"}}'),
    /invalid planner tool action/u
  );
});

test('parsePlannerAction recovers malformed escaped command payloads', () => {
  const malformed = '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"D:\\\\\\\\|C:\\\\\\\\|\\\\\\\\\\\\\\\\" src --type ts | Select-Object -First 30"}}';
  const action = parsePlannerAction(malformed);
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

test('evaluateCommandSafety allows allowlisted read-only commands', () => {
  assert.equal(evaluateCommandSafety('rg -n "planner" src').safe, true);
  assert.equal(evaluateCommandSafety('git status --short').safe, true);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts').safe, true);
  assert.equal(evaluateCommandSafety('Select-String -Path "src\\*.ts" -Pattern "planner"').safe, true);
  assert.equal(
    evaluateCommandSafety('Select-String -Path src\\summary.ts -Pattern "planner|debug" | Select-Object -Last 5').safe,
    true
  );
  assert.equal(
    evaluateCommandSafety('Get-ChildItem -Recurse -Filter *.ts -Name | Where-Object { $_ -notmatch \'node_modules\' } | Select-Object -First 30').safe,
    true
  );
});

test('evaluateCommandSafety treats drive-letter regex literals as patterns, not repo-escape paths', () => {
  const repoRoot = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit';
  assert.equal(
    evaluateCommandSafety('rg -n "D:\\\\|C:\\\\Users\\\\denys" . --type js --type ts --type ps1 --type json', repoRoot).safe,
    true
  );
  assert.equal(
    evaluateCommandSafety('Select-String -Path "src\\*.ts" -Pattern "C:\\\\Users\\\\denys|D:\\\\personal"', repoRoot).safe,
    true
  );
  assert.equal(
    evaluateCommandSafety('rg -n "planner" C:\\Windows\\System32 --type ts', repoRoot).safe,
    false
  );
  assert.equal(
    evaluateCommandSafety('Get-Content D:\\personal\\models\\config.json', repoRoot).safe,
    false
  );
});

test('evaluateCommandSafety rejects destructive, network, and chained commands', () => {
  assert.equal(evaluateCommandSafety('rm -rf .').safe, false);
  assert.equal(evaluateCommandSafety('curl http://127.0.0.1:8097/v1/models').safe, false);
  assert.equal(evaluateCommandSafety('rg planner src; del file.txt').safe, false);
  assert.equal(evaluateCommandSafety('rg planner src | findstr summary').safe, false);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts > out.txt').safe, false);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts | Select-Object -First 10 | Out-File out.txt').safe, false);
});

test('runTaskLoop rewrites unsupported rg --type tsx and annotates output', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-tsx',
      question: 'Find tsx hits.',
      signals: ['tsx hit'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"foo\\" --type tsx src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type ts': { exitCode: 0, stdout: 'tsx hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult.command).startsWith('rg -n "foo" src --type ts'));
  assert.match(String(commandResult.output || ''), /rewrote unsupported --type tsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop rewrites mixed rg --type ts and --type tsx flags', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-mixed-types',
      question: 'Find ts and tsx hits.',
      signals: ['mixed hit'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"foo\\" --type ts --type tsx src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type ts': { exitCode: 0, stdout: 'mixed hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult.command).startsWith('rg -n "foo" src --type ts'));
  assert.match(String(commandResult.output || ''), /rewrote unsupported --type tsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop reports prompt tokens and elapsed time on command progress events', async () => {
  const progressEvents: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-progress-metadata',
      question: 'Find planner text.',
      signals: ['planner'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
      },
      onProgress(event: Record<string, unknown> & { kind: string }) {
        progressEvents.push(event);
      },
    }
  );

  const toolStart = progressEvents.find((event) => event.kind === 'tool_start');
  assert.equal(typeof toolStart?.command, 'string');
  assert.equal(Number.isFinite(toolStart?.promptTokenCount), true);
  assert.equal(Number.isFinite(toolStart?.elapsedMs), true);
  assert.equal(Number(toolStart?.elapsedMs) >= 0, true);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop executes repo_list_files and repo_read_file natively', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
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
        repoRoot,
        maxTurns: 3,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          '{"action":"tool","tool_name":"repo_list_files","args":{"path":"src","glob":"*.ts","recurse":true}}',
          '{"action":"tool","tool_name":"repo_read_file","args":{"path":"src/sample.ts","startLine":2,"endLine":3}}',
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {},
        logger: {
          write(event: Record<string, unknown> & { kind: string }) {
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

test('runTaskLoop logs provider request error details and surfaces enriched network failures', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  await assert.rejects(
    () => runTaskLoop(
      {
        id: 'task-provider-network-error',
        question: 'Trigger a provider request failure.',
        signals: [],
      },
      {
        baseUrl: 'http://127.0.0.1:1',
        model: 'mock-model',
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        logger: {
          write(event: Record<string, unknown> & { kind: string }) {
            events.push(event);
          },
        },
      }
    ),
    /provider request failed stage=planner_action/u
  );

  const startEvent = events.find((event) => event.kind === 'provider_request_start');
  assert.equal(startEvent?.stage, 'planner_action');
  assert.equal(startEvent?.method, 'POST');
  assert.equal(startEvent?.path, '/v1/chat/completions');

  const errorEvent = events.find((event) => event.kind === 'provider_request_error');
  assert.equal(errorEvent?.stage, 'planner_action');
  assert.equal(typeof errorEvent?.elapsedMs, 'number');
  assert.equal(errorEvent?.elapsedMs >= 0, true);
  assert.equal(typeof errorEvent?.error, 'object');
  assert.equal(typeof errorEvent?.error?.message, 'string');
});

test('runTaskLoop rewrites unsupported rg --type tsx even when --glob is present', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-with-glob',
      question: 'Find tsx hits.',
      signals: ['tsx glob hit'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"foo\\" --type tsx --glob \\"*.tsx\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" --glob "*.tsx" src --type ts': { exitCode: 0, stdout: 'tsx glob hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult.command).startsWith('rg -n "foo" --glob "*.tsx" src --type ts'));
  assert.match(String(commandResult.output || ''), /rewrote unsupported --type tsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
});

test('runTaskLoop rewrites unsupported rg --type jsx to --type js', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-jsx',
      question: 'Find jsx hits.',
      signals: ['jsx hit'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"foo\\" --type jsx src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type js': { exitCode: 0, stdout: 'jsx hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult.command).startsWith('rg -n "foo" src --type js'));
  assert.match(String(commandResult.output || ''), /rewrote unsupported --type jsx to valid types/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop rewrites mixed --type jsx and --type tsx to --type js and --type ts', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-jsx-tsx',
      question: 'Find jsx and tsx hits.',
      signals: ['both hit'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"foo\\" --type jsx --type tsx src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "foo" src --type js --type ts': { exitCode: 0, stdout: 'both hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.ok(String(commandResult.command).startsWith('rg -n "foo" src --type js --type ts'));
  assert.match(String(commandResult.output || ''), /rewrote unsupported --type jsx, tsx to valid types/u);
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
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
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
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"better-sqlite3\\" src --type ts"}}',
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
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"grep -rn \\"TODO\\" src"}}',
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
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"git log --oneline"}}',
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
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 2,
      mockResponses: [
        JSON.stringify({
          action: 'tool_batch',
          tool_calls: [
            { tool_name: 'run_repo_cmd', args: { command: 'rg -n "planner prompt" src' } },
            { tool_name: 'run_repo_cmd', args: { command: 'rg -n "prompt budget" src' } },
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
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-min-depth',
      question: 'Find planner tools.',
      signals: ['done'],
    },
    {
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 2,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -First 20"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'src\\summary.ts:10:planner hit', stderr: '' },
        'Get-Content src\\summary.ts | Select-Object -First 20': { exitCode: 0, stdout: '10: planner hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
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
      maxTurns: 2,
      maxInvalidResponses: 3,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"buildPlannerPrompt\\" src\\\\summary.ts"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"buildPlannerPrompt\\" src\\\\summary.ts"}}',
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
});

test('runTaskLoop prompt omits visible tool-call budget counters', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-budget-hidden',
      question: 'Track tool usage.',
      signals: [],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"summary\\" src"}}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
        'rg -n "summary" src': { exitCode: 0, stdout: 'summary hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
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
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-prompt-single-file-guidance',
      question: 'Find planner text.',
      signals: [],
    },
    {
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: ['{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const systemMessage = (events.find((event) => event.kind === 'turn_new_messages' && event.turn === 1)?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.find((m) => m.role === 'system')?.content || '';
  const prompt = String(systemMessage);
  assert.match(prompt, /Single-file read strategy:/u);
  assert.match(prompt, /Start with `rg -n` to find anchors/u);
  assert.match(prompt, /default to one larger `repo_read_file` window around \d+ lines rather than multiple small windows/u);
  assert.match(prompt, /If you already read a file once, do a new anchor search before another read of that same file/u);
  assert.match(prompt, /read a larger section in one call/u);
  assert.match(prompt, /For reading a specific file section: use `repo_read_file`/u);
  assert.match(prompt, /Do not issue multiple consecutive reads of the same file with only small line-range changes/u);
  assert.match(prompt, /If a command returns an output token-allocation error, switch to stronger anchors/u);
  assert.equal(result.reason, 'finish');
});

test('buildTaskSystemPrompt reports learned get-content line guidance from idle-summary stats', () => {
  const prompt = buildTaskSystemPrompt(createTempRepoRoot(), {
    globalToolStats: {
      'get-content': {
        calls: 4,
        outputCharsTotal: 800,
        outputTokensTotal: 200,
        outputTokensEstimatedCount: 0,
        lineReadCalls: 4,
        lineReadLinesTotal: 80,
        lineReadTokensTotal: 200,
      },
    },
    initialPerToolAllowanceTokens: 1600,
  });

  assert.match(prompt, /current per-tool allowance is 1600 tokens/u);
  assert.match(prompt, /average line is 2\.50 tokens/u);
  assert.match(prompt, /prefer line reads around 320 lines/u);
  assert.doesNotMatch(prompt, /Do not use tiny windows \(`<120` lines\)/u);
});

test('runTaskLoop prompt examples use larger reads and anchor-first flow', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-prompt-example-guidance',
      question: 'Find planner text.',
      signals: [],
    },
    {
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: ['{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const systemMessage2 = (events.find((event) => event.kind === 'turn_new_messages' && event.turn === 1)?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.find((m) => m.role === 'system')?.content || '';
  const prompt = String(systemMessage2);
  assert.doesNotMatch(prompt, /Get-Content src\\\\summary\.ts/u);
  assert.match(prompt, /repo_list_files/u);
  assert.match(prompt, /rg -n \\"invokePlannerMode\\" src\\\\summary\.ts/u);
  assert.match(prompt, /repo_read_file/u);
  assert.match(prompt, /"path":"src\\\\summary\.ts","startLine":861,"endLine":1100/u);
  assert.match(prompt, /repo_read_file path=src\\summary\.ts startLine=1 endLine=40/u);
  assert.match(prompt, /repo_read_file path=src\\summary\.ts startLine=41 endLine=80/u);
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
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -Skip 40 -First 6"}}',
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
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-prompt-ignore-policy',
      question: 'Find planner text.',
      signals: [],
    },
    {
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: ['{"action":"finish","output":"done"}'],
      mockCommandResults: {},
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
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
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const repoRoot = createTempRepoRoot('/custom_ignored\n');
  try {
    const result = await runTaskLoop(
      {
        id: 'task-ignore-get-childitem',
        question: 'List source files.',
        signals: ['listed'],
      },
      {
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-ChildItem src -Recurse -Filter *.ts"}}',
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
          write(event: Record<string, unknown> & { kind: string }) {
            events.push(event);
          },
        },
      }
    );

    const commandResult = events.find((event) => event.kind === 'turn_command_result');
    assert.ok(
      String(commandResult.command).startsWith('Get-ChildItem src -Recurse -Filter *.ts -Exclude ')
    );
    assert.match(String(commandResult.command), /node_modules/u);
    assert.match(String(commandResult.output || ''), /added -Exclude from ignore policy/u);
    assert.equal(result.reason, 'finish');
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runTaskLoop rewrites Select-String path scan to include ignore excludes', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const repoRoot = createTempRepoRoot('/custom_ignored\n');
  try {
    const result = await runTaskLoop(
      {
        id: 'task-ignore-select-string',
        question: 'Find planner text.',
        signals: ['hit'],
      },
      {
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Select-String -Path \\"src\\\\*.ts\\" -Pattern \\"planner\\""}}',
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
          write(event: Record<string, unknown> & { kind: string }) {
            events.push(event);
          },
        },
      }
    );

    const commandResult = events.find((event) => event.kind === 'turn_command_result');
    assert.ok(
      String(commandResult.command).startsWith('Select-String -Path "src\\*.ts" -Pattern "planner" -Exclude ')
    );
    assert.match(String(commandResult.command), /node_modules/u);
    assert.match(String(commandResult.output || ''), /added -Exclude from ignore policy/u);
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
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src --no-ignore"}}',
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
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src -u"}}',
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
        repoRoot,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content node_modules\\\\leftpad\\\\index.js"}}',
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
  const chatRequests = [];
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
            action: 'tool',
            tool_name: 'run_repo_cmd',
            args: { command: 'rg -n "planner" src' },
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number(address.port)}`;

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
        config: {
          Runtime: {
            LlamaCpp: {
              BaseUrl: baseUrl,
              NumCtx: 70000,
              ParallelSlots: 4,
              Reasoning: 'off',
            },
          },
          LlamaCpp: {
            BaseUrl: baseUrl,
            NumCtx: 70000,
            ParallelSlots: 4,
            Reasoning: 'off',
          },
        },
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        requestMaxTokens: 256,
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
    assert.equal(chatRequests[0]?.response_format?.type, 'json_schema');
    assert.equal(Array.isArray(chatRequests[0].tools), true);
    assert.equal(chatRequests[0].parallel_tool_calls, true);
    assert.equal(chatRequests[1].messages.length > chatRequests[0].messages.length, true);
    assert.doesNotMatch(JSON.stringify(chatRequests[0].messages), /Tool-call budget remaining:/u);
    assert.doesNotMatch(JSON.stringify(chatRequests[1].messages), /Tool-call budget remaining:/u);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runTaskLoop keeps one duplicate warning tool turn and forces finish on the fifth duplicate', async () => {
  const chatRequests = [];
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
            action: 'tool',
            tool_name: 'run_repo_cmd',
            args: { command: 'rg -n "planner" src' },
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number(address.port)}`;

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
        config: {
          Runtime: {
            LlamaCpp: {
              BaseUrl: baseUrl,
              NumCtx: 70000,
              ParallelSlots: 4,
              Reasoning: 'off',
            },
          },
          LlamaCpp: {
            BaseUrl: baseUrl,
            NumCtx: 70000,
            ParallelSlots: 4,
            Reasoning: 'off',
          },
        },
        maxTurns: 6,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        requestMaxTokens: 256,
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
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
      maxTurns: 1,
      maxInvalidResponses: 3,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"buildPlannerPrompt\\" src\\\\summary.ts"}}',
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

