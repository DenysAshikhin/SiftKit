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
    tool_name: 'run_repo_cmd',
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
    tool_name: 'run_repo_cmd',
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
  assert.match(prompt, /default to one larger read around \d+ lines rather than multiple small windows/u);
  assert.match(prompt, /If you already read a file once, do a new anchor search before another read of that same file/u);
  assert.match(prompt, /read a larger section in one call/u);
  assert.match(prompt, /Prefer `Get-Content <file> -Raw` for full-file inspection when manageable/u);
  assert.match(prompt, /Do not issue multiple consecutive reads of the same file with only small `-Skip\/-First` changes/u);
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
  assert.doesNotMatch(prompt, /Get-Content src\\\\summary\.ts \| Select-Object -First 80/u);
  assert.match(prompt, /Get-Content src\\\\summary\.ts \| Select-Object -First 240/u);
  assert.match(prompt, /rg -n \\"invokePlannerMode\\" src\\\\summary\.ts/u);
  assert.match(prompt, /Get-Content src\\\\summary\.ts \| Select-Object -Skip 860 -First 240/u);
  assert.match(prompt, /Get-Content src\\summary\.ts \| Select-Object -First 40/u);
  assert.match(prompt, /Get-Content src\\summary\.ts \| Select-Object -Skip 40 -First 40/u);
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

test('runTaskLoop rejects rg ignore-disabling flags', async () => {
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
  assert.equal(result.commands[0].safe, false);
  assert.equal(result.commands[0].reason, 'ignore-disabling rg flags are not allowed');
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

test('runTaskLoop stops on invalid response limit', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-invalid',
      question: 'Any question.',
      signals: ['unused'],
    },
    {
      maxTurns: 10,
      maxInvalidResponses: 2,
      mockResponses: ['oops', 'still bad'],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'invalid_response_limit');
  assert.equal(result.invalidResponses, 2);
  assert.equal(result.commands.length, 0);
});

test('runTaskLoop replaces oversized tool output with token allowance error', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const totalContextTokens = 20000;
  const thinkingBufferTokens = Math.max(Math.ceil(totalContextTokens * 0.15), 4000);
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const baselinePerToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * 0.10));
  const result = await runTaskLoop(
    {
      id: 'task-token-guard',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': {
          exitCode: 0,
          stdout: 'x'.repeat(10000),
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

  const commandEvent = events.find((event) => event.kind === 'turn_command_result');
  assert.equal(typeof commandEvent?.insertedResultText, 'string');
  assert.equal(commandEvent?.perToolCapTokens, baselinePerToolCapTokens);
  assert.match(
    String(commandEvent?.insertedResultText || ''),
    /^Error: requested output would consume \d+ tokens, remaining token allowance: \d+, per tool call allowance: \d+$/u
  );
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop preserves raw line-read stats when oversized Get-Content output is replaced', async () => {
  const oversizedLines = Array.from({ length: 300 }, (_, index) => `line-${index + 1} ${'x'.repeat(40)}`).join('\n');
  const result = await runTaskLoop(
    {
      id: 'task-oversized-line-read-stats',
      question: 'Read a large file section.',
      signals: [],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -First 300"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'Get-Content src\\summary.ts | Select-Object -First 300': {
          exitCode: 0,
          stdout: oversizedLines,
          stderr: '',
        },
      },
    }
  );

  assert.equal(result.toolStats['get-content'].lineReadCalls, 1);
  assert.equal(result.toolStats['get-content'].lineReadLinesTotal, 300);
  assert.ok(
    Number(result.toolStats['get-content'].lineReadTokensTotal) > Number(result.toolStats['get-content'].outputTokensTotal)
  );
});

test('runTaskLoop prints a red console warning when tool output exceeds allowance', async () => {
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk, encoding, callback) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (typeof callback === 'function') {
      callback();
    } else if (typeof encoding === 'function') {
      encoding();
    }
    return true;
  });
  try {
    const totalContextTokens = 20000;
    await runTaskLoop(
      {
        id: 'task-token-guard-console-warning',
        question: 'Find planner text.',
        signals: ['done'],
      },
      {
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        totalContextTokens,
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
          '{"action":"finish","output":"done"}',
          '{"verdict":"pass","reason":"supported"}',
        ],
        mockCommandResults: {
          'rg -n "planner" src': {
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
  assert.equal(Boolean(redWarning), true);
});

test('preflightPlannerPromptBudget reports overflow against context budget', async () => {
  const preflight = await preflightPlannerPromptBudget({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'x'.repeat(10000) },
    ],
    totalContextTokens: 7000,
    thinkingBufferTokens: 4000,
    requestMaxTokens: 2000,
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.maxPromptBudget, 1000);
  assert.equal(preflight.promptTokenCount > preflight.maxPromptBudget, true);
  assert.equal(preflight.overflowTokens > 0, true);
});

test('compactPlannerMessagesOnce preserves system and latest user intent', async () => {
  const messages = [
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

test('runTaskLoop fails with planner_preflight_overflow before provider request when compaction cannot fit', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  await assert.rejects(
    () => runTaskLoop(
      {
        id: 'task-preflight-overflow-hard-fail',
        question: 'Q'.repeat(12000),
        signals: [],
      },
      {
        baseUrl: 'http://127.0.0.1:1',
        model: 'mock-model',
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        totalContextTokens: 7000,
        requestMaxTokens: 2000,
        logger: {
          write(event: Record<string, unknown> & { kind: string }) {
            events.push(event);
          },
        },
      }
    ),
    /planner_preflight_overflow/u
  );

  const providerStart = events.find((event) => event.kind === 'provider_request_start');
  assert.equal(Boolean(providerStart), false);
  const overflowEvent = events.find((event) => event.kind === 'turn_preflight_overflow_fail');
  assert.equal(Boolean(overflowEvent), true);
  assert.equal(Number(overflowEvent.overflowTokens) > 0, true);
});

test('runTaskLoop applies one-pass compaction and continues when compacted prompt fits', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-preflight-compaction-success',
      question: 'Find planner references.',
      signals: ['done'],
    },
    {
      maxTurns: 5,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 30000,
      requestMaxTokens: 20000,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" lib"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" test"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'a'.repeat(6000), stderr: '' },
        'rg -n "planner" lib': { exitCode: 0, stdout: 'b'.repeat(6000), stderr: '' },
        'rg -n "planner" test': { exitCode: 0, stdout: 'c'.repeat(6000), stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const compactionEvents = events.filter((event) => event.kind === 'turn_preflight_compaction_applied');
  assert.equal(compactionEvents.length >= 1, true);
  assert.equal(compactionEvents[0].droppedMessageCount > 0, true);
  const newMessagesEvents = events.filter((event) => event.kind === 'turn_new_messages');
  const allCompactedContent = newMessagesEvents
    .flatMap((event) => Array.isArray(event.messages) ? event.messages as Array<{ content?: unknown }> : [])
    .map((m) => String(m.content || ''));
  assert.equal(allCompactedContent.some((c) => c.includes('[COMPRESSED HISTORICAL EVIDENCE]')), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop increases per-tool cap as tool-call progress grows', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
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
      maxTurns: 10,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"summary\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"repo\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
        'rg -n "summary" src': { exitCode: 0, stdout: 'summary hit', stderr: '' },
        'rg -n "repo" src': { exitCode: 0, stdout: 'repo hit', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
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

test('runTaskLoop still rejects tool output that exceeds remaining token allowance', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const totalContextTokens = 30000;
  const oversizedQuestion = 'Q'.repeat(90000);
  const result = await runTaskLoop(
    {
      id: 'task-remaining-token-guard',
      question: oversizedQuestion,
      signals: ['done'],
    },
    {
      maxTurns: 10,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens,
      requestMaxTokens: 1000,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': {
          exitCode: 0,
          stdout: 'x'.repeat(10000),
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

  const commandEvent = events.find((event) => event.kind === 'turn_command_result');
  assert.equal(typeof commandEvent?.insertedResultText, 'string');
  assert.equal(commandEvent?.perToolCapTokens > commandEvent?.remainingTokenAllowance, true);
  assert.match(
    String(commandEvent?.insertedResultText || ''),
    /^Error: requested output would consume \d+ tokens, remaining token allowance: \d+, per tool call allowance: \d+$/u
  );
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop follows up once after non-thinking finish and preserves first finish output after confirmation', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-validation-pass',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"first finish"}',
        '{"action":"finish","output":"second finish"}',
      ],
      mockCommandResults: {},
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 2);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, true);

  const followupEvent = events.find((event) => event.kind === 'turn_non_thinking_finish_followup');
  assert.equal(Boolean(followupEvent), true);
  assert.match(
    String(followupEvent.followupPrompt),
    /Are you sure you have everything\?/u
  );

  const followupContent = events
    .filter((event) => event.kind === 'turn_new_messages')
    .flatMap((event) => Array.isArray(event.messages) ? event.messages as Array<{ role?: string; content?: unknown }> : [])
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content || ''))
    .find((c) => c.includes('Are you sure')) || '';
  assert.match(followupContent, /only respond with `yes i am sure`/iu);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'first finish');
});

test('runTaskLoop triggers non-thinking finish follow-up only once', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-validation-fail',
      question: 'Find planner text.',
      signals: ['final answer'],
    },
    {
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"first answer"}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"final answer\\" src"}}',
        '{"action":"finish","output":"final answer"}',
      ],
      mockCommandResults: {
        'rg -n "final answer" src': { exitCode: 0, stdout: 'final answer', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const followupEvents = events.filter((event) => event.kind === 'turn_non_thinking_finish_followup');
  assert.equal(followupEvents.length, 1);
  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 3);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, true);
  assert.equal(turnRequests[2].thinkingEnabled, false);
  const skippedValidation = events.find((event) => event.kind === 'turn_finish_validation_skipped');
  assert.equal(Boolean(skippedValidation), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'final answer');
});

test('runTaskLoop counts malformed response after non-thinking finish follow-up toward invalid response limit', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-validation-invalid',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 1,
      minToolCallsBeforeFinish: 0,
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"done"}',
        'not-json',
      ],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'invalid_response_limit');
  assert.equal(result.invalidResponses, 1);
});

test('runTaskLoop accepts exact "yes i am sure" after non-thinking finish follow-up', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-validation-exact-confirmation',
      question: 'Find planner text.',
      signals: ['first finish'],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"first finish"}',
        'yes i am sure',
      ],
      mockCommandResults: {},
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const accepted = events.find((event) => event.kind === 'turn_followup_confirmation_accepted');
  assert.equal(Boolean(accepted), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'first finish');
  assert.equal(result.invalidResponses, 0);
});

test('runTaskLoop accepts follow-up confirmation when first ten words include yes and sure', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-validation-fuzzy-confirmation',
      question: 'Find planner text.',
      signals: ['first finish'],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"first finish"}',
        'yes please proceed, sure this is complete',
      ],
      mockCommandResults: {},
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const accepted = events.find((event) => event.kind === 'turn_followup_confirmation_accepted');
  assert.equal(Boolean(accepted), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'first finish');
  assert.equal(result.invalidResponses, 0);
});

test('runTaskLoop still follows up after non-thinking finish when fewer than ten tool calls ran', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const mockResponses = [
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-1\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-2\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-3\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-4\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-5\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-6\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-7\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-8\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-9\\" src"}}',
    '{"action":"finish","output":"src\\\\target.ts:9"}',
    'yes i am sure',
  ];
  const mockCommandResults = {
    'rg -n "hit-1" src': { exitCode: 0, stdout: 'src\\target.ts:1: hit-1', stderr: '' },
    'rg -n "hit-2" src': { exitCode: 0, stdout: 'src\\target.ts:2: hit-2', stderr: '' },
    'rg -n "hit-3" src': { exitCode: 0, stdout: 'src\\target.ts:3: hit-3', stderr: '' },
    'rg -n "hit-4" src': { exitCode: 0, stdout: 'src\\target.ts:4: hit-4', stderr: '' },
    'rg -n "hit-5" src': { exitCode: 0, stdout: 'src\\target.ts:5: hit-5', stderr: '' },
    'rg -n "hit-6" src': { exitCode: 0, stdout: 'src\\target.ts:6: hit-6', stderr: '' },
    'rg -n "hit-7" src': { exitCode: 0, stdout: 'src\\target.ts:7: hit-7', stderr: '' },
    'rg -n "hit-8" src': { exitCode: 0, stdout: 'src\\target.ts:8: hit-8', stderr: '' },
    'rg -n "hit-9" src': { exitCode: 0, stdout: 'src\\target.ts:9: hit-9', stderr: '' },
  };
  const result = await runTaskLoop(
    {
      id: 'task-validation-nine-tool-calls',
      question: 'Find planner text.',
      signals: ['src\\target.ts:9'],
    },
    {
      maxTurns: 11,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      thinkingInterval: 20,
      enforceThinkingFinish: true,
      mockResponses,
      mockCommandResults,
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const followupEvent = events.find((event) => event.kind === 'turn_non_thinking_finish_followup');
  const autoAcceptedEvent = events.find((event) => event.kind === 'turn_non_thinking_finish_auto_accepted');
  assert.equal(Boolean(followupEvent), true);
  assert.equal(Boolean(autoAcceptedEvent), false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'src\\target.ts:9');
});

test('runTaskLoop auto-accepts non-thinking finish after ten tool calls without follow-up', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const mockResponses = [
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-1\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-2\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-3\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-4\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-5\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-6\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-7\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-8\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-9\\" src"}}',
    '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"hit-10\\" src"}}',
    '{"action":"finish","output":"src\\\\target.ts:10"}',
  ];
  const mockCommandResults = {
    'rg -n "hit-1" src': { exitCode: 0, stdout: 'src\\target.ts:1: hit-1', stderr: '' },
    'rg -n "hit-2" src': { exitCode: 0, stdout: 'src\\target.ts:2: hit-2', stderr: '' },
    'rg -n "hit-3" src': { exitCode: 0, stdout: 'src\\target.ts:3: hit-3', stderr: '' },
    'rg -n "hit-4" src': { exitCode: 0, stdout: 'src\\target.ts:4: hit-4', stderr: '' },
    'rg -n "hit-5" src': { exitCode: 0, stdout: 'src\\target.ts:5: hit-5', stderr: '' },
    'rg -n "hit-6" src': { exitCode: 0, stdout: 'src\\target.ts:6: hit-6', stderr: '' },
    'rg -n "hit-7" src': { exitCode: 0, stdout: 'src\\target.ts:7: hit-7', stderr: '' },
    'rg -n "hit-8" src': { exitCode: 0, stdout: 'src\\target.ts:8: hit-8', stderr: '' },
    'rg -n "hit-9" src': { exitCode: 0, stdout: 'src\\target.ts:9: hit-9', stderr: '' },
    'rg -n "hit-10" src': { exitCode: 0, stdout: 'src\\target.ts:10: hit-10', stderr: '' },
  };
  const result = await runTaskLoop(
    {
      id: 'task-validation-ten-tool-calls',
      question: 'Find planner text.',
      signals: ['src\\target.ts:10'],
    },
    {
      maxTurns: 11,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      thinkingInterval: 20,
      enforceThinkingFinish: true,
      mockResponses,
      mockCommandResults,
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const followupEvent = events.find((event) => event.kind === 'turn_non_thinking_finish_followup');
  const autoAcceptedEvent = events.find((event) => event.kind === 'turn_non_thinking_finish_auto_accepted');
  assert.equal(Boolean(followupEvent), false);
  assert.equal(Boolean(autoAcceptedEvent), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'src\\target.ts:10');
});

test('runTaskLoop forces thinking on after non-thinking finish follow-up and can still hit max turns', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-validation-max-turns',
      question: 'Find planner text.',
      signals: ['never-hits'],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"first answer"}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner2\\" src"}}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner', stderr: '' },
        'rg -n "planner2" src': { exitCode: 0, stdout: 'planner2', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 3);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, true);
  assert.equal(turnRequests[2].thinkingEnabled, false);
  assert.equal(result.reason, 'max_turns');
});

test('runTaskLoop retries transient provider network failures via shared retry helper', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
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
        ? '{"action":"finish","output":"done","confidence":0.9}'
        : `{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"q${toolIndex}\\" src"}}`;
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runTaskLoop(
      {
        id: 'task-retry-on-switch',
        question: 'Find planner text.',
        signals: ['done'],
      },
      {
        baseUrl,
        model: 'mock-model',
        maxTurns: 6,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        mockCommandResults: {
          'rg -n "q1" src': { exitCode: 0, stdout: 'q1', stderr: '' },
          'rg -n "q2" src': { exitCode: 0, stdout: 'q2', stderr: '' },
          'rg -n "q3" src': { exitCode: 0, stdout: 'q3', stderr: '' },
          'rg -n "q4" src': { exitCode: 0, stdout: 'q4', stderr: '' },
        },
        logger: {
          write(event: Record<string, unknown> & { kind: string }) {
            events.push(event);
          },
        },
      }
    );

    assert.equal(result.reason, 'finish');
    assert.equal(result.finalOutput, 'done');
    assert.equal(requestCount, 6);
    // Response-format constrained mode suppresses enable_thinking in the HTTP body.
    // Verify the engine still tracked the thinking switch internally via logged events.
    const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
    assert.equal(turnRequests.length >= 5, true);
    assert.equal(Boolean(turnRequests[0]?.thinkingEnabled), false);
    assert.equal(Boolean(turnRequests[3]?.thinkingEnabled), false);
    assert.equal(Boolean(turnRequests[4]?.thinkingEnabled), true);
    const retryEvent = events.find((event) => event.kind === 'provider_request_retry');
    assert.equal(Boolean(retryEvent), true);
    assert.equal(retryEvent.stage, 'planner_action');
    assert.equal(retryEvent.attempt, 1);
    assert.equal(Number(retryEvent.nextDelayMs) > 0, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runTaskLoop waits for planner endpoint warm-up when initial connections are refused', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
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
        baseUrl: `http://127.0.0.1:${port}`,
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
    );
    assert.equal(result.reason, 'finish');
    assert.equal(result.finalOutput, 'done');
    assert.equal(plannerRequestCount >= 1, true);
    const retryEvents = events.filter((event) => event.kind === 'provider_request_retry');
    assert.equal(retryEvents.length >= 1, true);
    assert.match(String(retryEvents[0]?.error?.message || ''), /ECONNREFUSED/u);
  } finally {
    clearTimeout(delayedStart);
    if (delayedServer) {
      await new Promise<void>((resolve) => delayedServer!.close(() => resolve()));
    }
  }
});

test('runTaskLoop retries planner calls when endpoint returns HTTP 503 Loading model', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
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
        baseUrl: `http://127.0.0.1:${port}`,
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
    );
    assert.equal(result.reason, 'finish');
    assert.equal(result.finalOutput, 'done');
    assert.equal(plannerRequestCount, 2);
    const retryEvents = events.filter((event) => event.kind === 'provider_request_retry');
    assert.equal(retryEvents.length >= 1, true);
    assert.match(String(retryEvents[0]?.error?.message || ''), /Loading model/u);
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
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 2, stdout: '', stderr: 'boom' },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.turnsUsed, 3);
  assert.equal(result.commandFailures, 2);
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
      maxTurns: 5,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"4319\\" apps/runner/src --glob \\"!**/__tests__/**\\" --glob \\"!**/*.test.*\\""}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"4319\\" apps/runner/src --glob \\"!**/__tests__/**\\" --glob \\"!**/*.test.*\\" --glob \\"!**/*.spec.*\\" --glob \\"!**/*.d.ts\\""}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content apps/runner/src/server.ts | Select-Object -Skip 195 -First 20"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "4319" apps/runner/src --glob "!**/__tests__/**" --glob "!**/*.test.*"': {
          exitCode: 0,
          stdout: 'apps/runner/src\\server.ts:203:  const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
          stderr: '',
        },
        'Get-Content apps/runner/src/server.ts | Select-Object -Skip 195 -First 20': {
          exitCode: 0,
          stdout: '  const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
          stderr: '',
        },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 3);
  assert.equal(result.commands[1].safe, false);
  assert.equal(String(result.commands[1].reason || ''), 'semantic duplicate command');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop keeps raw rewrite notes in logs but inserts compact repo-search results into the prompt', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-compact-repo-search-result',
      question: 'Find runner port.',
      signals: ['done'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"4319\\" apps/runner/src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "4319" apps/runner/src': {
          exitCode: 0,
          stdout: 'apps/runner/src\\server.ts:203:  const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
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

  const commandEvent = events.find((event) => event.kind === 'turn_command_result');
  assert.match(String(commandEvent?.output || ''), /^note:/mu);
  assert.doesNotMatch(String(commandEvent?.insertedResultText || ''), /^note:/mu);
  assert.doesNotMatch(String(commandEvent?.insertedResultText || ''), /^exit_code=0$/mu);
  assert.match(String(commandEvent?.insertedResultText || ''), /apps\/runner\/src\\server\.ts:203/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop widens repeated Get-Content reads on the same file and logs requested vs adjusted window', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-widen-repeated-get-content',
      question: 'Find runner port.',
      signals: ['done'],
    },
    {
      maxTurns: 5,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -First 5"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -Skip 0 -First 5"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\other.ts | Select-Object -First 5"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'Get-Content src\\summary.ts | Select-Object -First 5': {
          exitCode: 0,
          stdout: 'a\nb\nc\nd\ne',
          stderr: '',
        },
        'Get-Content src\\summary.ts | Select-Object -Skip 0 -First ': {
          exitCode: 0,
          stdout: 'line\n'.repeat(600),
          stderr: '',
        },
        'Get-Content src\\other.ts | Select-Object -First 5': {
          exitCode: 0,
          stdout: 'x\ny\nz',
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

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 3);
  assert.equal(commandEvents[0]?.lineReadAdjusted, false);
  assert.equal(commandEvents[1]?.lineReadAdjusted, true);
  assert.equal(commandEvents[2]?.lineReadAdjusted, false);
  assert.match(String(commandEvents[1]?.requestedCommand || ''), /Select-Object -Skip 0 -First 5/u);
  assert.match(String(commandEvents[1]?.executedCommand || ''), /Select-Object -Skip \d+ -First \d+/u);
  assert.equal(Number(commandEvents[1]?.lineReadRequestedStart), 0);
  assert.equal(Number(commandEvents[1]?.lineReadAdjustedStart) >= Number(commandEvents[0]?.lineReadExecutedEnd), true);
  assert.equal(Number(commandEvents[1]?.lineReadRequestedEnd), 5);
  assert.equal(Number(commandEvents[1]?.lineReadAdjustedEnd) % 10, 0);
  assert.equal(Number(commandEvents[1]?.lineReadAdjustedEnd) > Number(commandEvents[1]?.lineReadRequestedEnd), true);
  assert.equal(Number(commandEvents[1]?.lineReadOverlapLines), 0);
  assert.equal(Number(commandEvents[1]?.lineReadNewLinesCovered) > 0, true);
  assert.equal(Number(commandEvents[1]?.lineReadExecutedStart), Number(commandEvents[1]?.lineReadAdjustedStart));
  assert.equal(Number(commandEvents[1]?.lineReadExecutedEnd), Number(commandEvents[1]?.lineReadAdjustedEnd));
  assert.match(String(commandEvents[1]?.output || ''), /^note: repeated file read window adjusted/mu);
  assert.doesNotMatch(String(commandEvents[1]?.insertedResultText || ''), /^note:/mu);
  const turn3NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3);
  const turn3AssistantMessages = Array.isArray(turn3NewMessages?.messages)
    ? turn3NewMessages.messages.filter((message: { role?: string }) => message.role === 'assistant')
    : [];
  assert.equal(turn3AssistantMessages.length > 0, true);
  const replayedAssistantPayload = String(turn3AssistantMessages[turn3AssistantMessages.length - 1]?.content || '');
  const replayedAssistantAction = JSON.parse(replayedAssistantPayload);
  assert.equal(String(replayedAssistantAction?.args?.command || ''), String(commandEvents[1]?.executedCommand || ''));
  assert.notEqual(String(replayedAssistantAction?.args?.command || ''), String(commandEvents[1]?.requestedCommand || ''));
  const turn3UserMessages = Array.isArray(turn3NewMessages?.messages)
    ? turn3NewMessages.messages.filter((message: { role?: string }) => message.role === 'user')
    : [];
  const replayedToolResultForPrompt = String(turn3UserMessages[turn3UserMessages.length - 1]?.content || '');
  assert.doesNotMatch(replayedToolResultForPrompt, /requested start=/u);
  assert.doesNotMatch(replayedToolResultForPrompt, /adjusted start=/u);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop clamps adjusted repeated Get-Content skip to non-negative values', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-widen-repeated-negative-skip',
      question: 'Find runner port.',
      signals: ['done'],
    },
    {
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -First 2"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -Skip -5 -First 2"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'Get-Content src\\summary.ts | Select-Object -First 2': {
          exitCode: 0,
          stdout: 'a\nb',
          stderr: '',
        },
        'Get-Content src\\summary.ts | Select-Object -Skip 0 -First 340': {
          exitCode: 0,
          stdout: 'line\n'.repeat(340),
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

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 2);
  assert.equal(commandEvents[1]?.lineReadAdjusted, true);
  assert.match(String(commandEvents[1]?.executedCommand || ''), /-Skip \d+ -First \d+/u);
  assert.doesNotMatch(String(commandEvents[1]?.executedCommand || ''), /-Skip -/u);
  assert.equal(Number(commandEvents[1]?.lineReadAdjustedStart) >= Number(commandEvents[0]?.lineReadExecutedEnd), true);
  assert.equal(Number(commandEvents[1]?.lineReadAdjustedEnd) % 10, 0);
  assert.equal(Number(commandEvents[1]?.lineReadAdjustedEnd) > Number(commandEvents[1]?.lineReadRequestedEnd), true);
  assert.equal(Number(commandEvents[1]?.lineReadOverlapLines), 0);
  assert.equal(Number(commandEvents[1]?.lineReadExecutedStart), Number(commandEvents[1]?.lineReadAdjustedStart));
  assert.equal(Number(commandEvents[1]?.lineReadExecutedEnd), Number(commandEvents[1]?.lineReadAdjustedEnd));
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop forces repeated backward same-file reads to non-overlapping forward windows', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-widen-repeated-backward-window',
      question: 'Find runner port.',
      signals: ['done'],
    },
    {
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -Skip 500 -First 40"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\summary.ts | Select-Object -Skip 450 -First 40"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'Get-Content src\\summary.ts | Select-Object -Skip 500 -First 40': {
          exitCode: 0,
          stdout: 'line\n'.repeat(40),
          stderr: '',
        },
        'Get-Content src\\summary.ts | Select-Object -Skip ': {
          exitCode: 0,
          stdout: 'line\n'.repeat(400),
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

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 2);
  assert.equal(commandEvents[1]?.lineReadAdjusted, true);
  assert.equal(Number(commandEvents[1]?.lineReadExecutedStart) >= Number(commandEvents[0]?.lineReadExecutedEnd), true);
  assert.equal(Number(commandEvents[1]?.lineReadOverlapLines), 0);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop tracks per-file overlap telemetry and isolates histories across files', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-line-read-overlap-metrics',
      question: 'Find runner port.',
      signals: ['done'],
    },
    {
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\a.ts | Select-Object -Skip 100 -First 20"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\b.ts | Select-Object -Skip 50 -First 20"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"Get-Content src\\\\a.ts | Select-Object -Skip 110 -First 20"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'Get-Content src\\a.ts | Select-Object -Skip 100 -First 20': {
          exitCode: 0,
          stdout: 'line\n'.repeat(20),
          stderr: '',
        },
        'Get-Content src\\b.ts | Select-Object -Skip 50 -First 20': {
          exitCode: 0,
          stdout: 'line\n'.repeat(20),
          stderr: '',
        },
        'Get-Content src\\a.ts | Select-Object -Skip ': {
          exitCode: 0,
          stdout: 'line\n'.repeat(400),
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

  const commandEvents = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(commandEvents.length, 3);
  for (const commandEvent of commandEvents) {
    assert.equal(typeof commandEvent?.lineReadRequestedStart, 'number');
    assert.equal(typeof commandEvent?.lineReadRequestedEnd, 'number');
    assert.equal(typeof commandEvent?.lineReadExecutedStart, 'number');
    assert.equal(typeof commandEvent?.lineReadExecutedEnd, 'number');
    assert.equal(typeof commandEvent?.lineReadOverlapLines, 'number');
    assert.equal(typeof commandEvent?.lineReadNewLinesCovered, 'number');
    assert.equal(typeof commandEvent?.lineReadCumulativeUniqueLines, 'number');
  }

  assert.equal(Number(commandEvents[2]?.lineReadExecutedStart) >= Number(commandEvents[0]?.lineReadExecutedEnd), true);
  assert.equal(Number(commandEvents[2]?.lineReadOverlapLines), 0);

  const overlapSummary = result.readOverlapSummary;
  assert.equal(typeof overlapSummary?.totalLinesRead, 'number');
  assert.equal(typeof overlapSummary?.totalUniqueLinesRead, 'number');
  assert.equal(typeof overlapSummary?.totalOverlapLines, 'number');
  assert.equal(Number(overlapSummary?.totalLinesRead) >= Number(overlapSummary?.totalUniqueLinesRead), true);
  assert.equal(
    Number(overlapSummary?.totalOverlapLines),
    Number(overlapSummary?.totalLinesRead) - Number(overlapSummary?.totalUniqueLinesRead)
  );
  assert.equal(Number(overlapSummary?.totalOverlapLines), 0);
  assert.equal(Array.isArray(overlapSummary?.byFile), true);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop collapses repeated no-new-evidence tool replays and forces finish at x4', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-collapse-repeat-replay',
      question: 'Find runner port.',
      signals: ['done'],
    },
    {
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"alpha\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"beta\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"gamma\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"delta\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "alpha" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        'rg -n "beta" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        'rg -n "gamma" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
        'rg -n "delta" src': { exitCode: 0, stdout: 'src\\app.ts:10: same evidence', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const turn3NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3);
  assert.equal(Array.isArray(turn2NewMessages?.messages) ? turn2NewMessages.messages.length : -1, 2);
  assert.equal(Array.isArray(turn3NewMessages?.messages) ? turn3NewMessages.messages.length : -1, 0);

  const forcedStart = events.find((event) => event.kind === 'turn_forced_finish_mode_started' && event.trigger === 'no_new_evidence');
  assert.ok(forcedStart);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop forces finish mode after ten zero-output commands', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const mockResponses = [];
  const mockCommandResults = {};
  for (let index = 1; index <= 10; index += 1) {
    const command = `rg -n q${index} src`;
    mockResponses.push(`{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"${command}"}}`);
    mockCommandResults[command] = { exitCode: 0, stdout: '', stderr: '' };
  }
  mockResponses.push('{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n forced src"}}');
  mockResponses.push('{"action":"finish","output":"forced conclusion"}');
  const result = await runTaskLoop(
    {
      id: 'task-zero-output-force-finish',
      question: 'Find planner text.',
      signals: [],
    },
    {
      maxTurns: 12,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses,
      mockCommandResults,
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const forcedStart = events.find((event) => event.kind === 'turn_forced_finish_mode_started');
  assert.ok(forcedStart);
  const turn11Request = events.find((event) => event.kind === 'turn_model_request' && event.turn === 11);
  assert.equal(turn11Request.thinkingEnabled, true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'forced conclusion');
});

test('runTaskLoop enables thinking on every fifth tool-call turn', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-third-cadence',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"a\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"b\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"c\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"d\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"e\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "a" src': { exitCode: 0, stdout: 'a', stderr: '' },
        'rg -n "b" src': { exitCode: 0, stdout: 'b', stderr: '' },
        'rg -n "c" src': { exitCode: 0, stdout: 'c', stderr: '' },
        'rg -n "d" src': { exitCode: 0, stdout: 'd', stderr: '' },
        'rg -n "e" src': { exitCode: 0, stdout: 'e', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 6);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, false);
  assert.equal(turnRequests[2].thinkingEnabled, false);
  assert.equal(turnRequests[3].thinkingEnabled, false);
  assert.equal(turnRequests[4].thinkingEnabled, true);
  assert.equal(turnRequests[5].thinkingEnabled, false);
  assert.equal(result.reason, 'finish');
});

test('buildScorecard aggregates totals and verdict', () => {
  const scorecard = buildScorecard({
    runId: 'run-1',
    model: 'model-x',
    tasks: [
      {
        id: 'a',
        passed: true,
        safetyRejects: 1,
        invalidResponses: 0,
        commandFailures: 0,
        commands: [{ command: 'rg x', safe: true }],
        missingSignals: [],
      },
      {
        id: 'b',
        passed: false,
        safetyRejects: 2,
        invalidResponses: 1,
        commandFailures: 1,
        commands: [{ command: 'rg y', safe: true }, { command: 'rg z', safe: false }],
        missingSignals: ['signal-1'],
      },
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
