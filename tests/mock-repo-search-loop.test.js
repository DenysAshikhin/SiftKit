const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePlannerAction,
  evaluateCommandSafety,
  runTaskLoop,
  buildScorecard,
  assertConfiguredModelPresent,
  runMockRepoSearch,
} = require('../scripts/mock-repo-search-loop.js');

test('assertConfiguredModelPresent hard-fails when configured model is missing', () => {
  assert.throws(
    () => assertConfiguredModelPresent('Qwen3.5-9B-Q8_0.gguf', ['Qwen3.5-27B-Q4_K_M.gguf']),
    /Configured model not found/u
  );
});

test('runMockRepoSearch does not fail on model inventory mismatch', async () => {
  const scorecard = await runMockRepoSearch({
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

test('evaluateCommandSafety rejects destructive, network, and chained commands', () => {
  assert.equal(evaluateCommandSafety('rm -rf .').safe, false);
  assert.equal(evaluateCommandSafety('curl http://127.0.0.1:8097/v1/models').safe, false);
  assert.equal(evaluateCommandSafety('rg planner src; del file.txt').safe, false);
  assert.equal(evaluateCommandSafety('rg planner src | findstr summary').safe, false);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts > out.txt').safe, false);
  assert.equal(evaluateCommandSafety('Get-Content src\\summary.ts | Select-Object -First 10 | Out-File out.txt').safe, false);
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
      mockResponses: ['{"action":"finish","output":"find_text read_lines json_filter"}'],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.turnsUsed, 1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop rejects shallow finish before minimum tool-call depth', async () => {
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
        '{"action":"finish","output":"too early"}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"tool\\" src"}}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner hit', stderr: '' },
        'rg -n "tool" src': { exitCode: 0, stdout: 'tool hit', stderr: '' },
      },
    }
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.commands.length, 2);
  assert.equal(result.finalOutput, 'done');
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
  const events = [];
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
      totalContextTokens: 120,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': {
          exitCode: 0,
          stdout: 'x'.repeat(2000),
          stderr: '',
        },
      },
      logger: {
        write(event) {
          events.push(event);
        },
      },
    }
  );

  const commandEvent = events.find((event) => event.kind === 'turn_command_result');
  assert.equal(typeof commandEvent?.insertedResultText, 'string');
  assert.match(
    String(commandEvent?.insertedResultText || ''),
    /^Error: requested output would consume \d+ tokens, remaining token allowance: \d+, per tool call allowance: \d+$/u
  );
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
        commands: [{ command: 'rg x', safe: true }],
        missingSignals: [],
      },
      {
        id: 'b',
        passed: false,
        safetyRejects: 2,
        invalidResponses: 1,
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
  assert.equal(scorecard.totals.commandsExecuted, 3);
  assert.equal(scorecard.verdict, 'fail');
  assert.equal(scorecard.failureReasons.length, 1);
});
