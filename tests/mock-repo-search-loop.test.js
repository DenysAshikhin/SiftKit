const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePlannerAction,
  evaluateCommandSafety,
  runTaskLoop,
  buildScorecard,
  assertConfiguredModelPresent,
  runMockRepoSearch,
  resolveRepoSearchRequestMaxTokens,
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

test('runTaskLoop rewrites unsupported rg --type tsx and annotates output', async () => {
  const events = [];
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
        'rg -n "foo" src --glob "*.tsx"': { exitCode: 0, stdout: 'tsx hit', stderr: '' },
      },
      logger: {
        write(event) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.equal(commandResult.command, 'rg -n "foo" src --glob "*.tsx"');
  assert.match(String(commandResult.output || ''), /original command failed compatibility check/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop rewrites mixed rg --type ts and --type tsx flags', async () => {
  const events = [];
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
        'rg -n "foo" src --glob "*.tsx" --glob "*.ts"': { exitCode: 0, stdout: 'mixed hit', stderr: '' },
      },
      logger: {
        write(event) {
          events.push(event);
        },
      },
    }
  );

  const commandResult = events.find((event) => event.kind === 'turn_command_result');
  assert.equal(commandResult.command, 'rg -n "foo" src --glob "*.tsx" --glob "*.ts"');
  assert.match(String(commandResult.output || ''), /original command failed compatibility check/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop rejects unsupported rg type rewrite when not safe to rewrite', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-rewrite-reject',
      question: 'Find tsx hits.',
      signals: [],
    },
    {
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"foo\\" --type tsx --glob \\"*.tsx\\" src"}}',
      ],
      mockCommandResults: {},
    }
  );

  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].safe, false);
  assert.match(String(result.commands[0].output || ''), /use --glob "\*\.tsx" or --type ts/u);
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
        '{"verdict":"pass","reason":"supported"}',
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
        '{"verdict":"pass","reason":"supported"}',
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

test('runTaskLoop uses non-thinking planner turns, then thinking validation, and stops on validation pass', async () => {
  const events = [];
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
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'done', stderr: '' },
      },
      logger: {
        write(event) {
          events.push(event);
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 2);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, false);

  const validationRequest = events.find((event) => event.kind === 'turn_finish_validation_requested');
  assert.equal(validationRequest.thinkingEnabled, true);
  const validationResult = events.find((event) => event.kind === 'turn_finish_validation_result');
  assert.equal(validationResult.verdict, 'pass');
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop switches to thinking mode after validation fail and can finish later', async () => {
  const events = [];
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
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"first answer"}',
        '{"verdict":"fail","reason":"not enough evidence"}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"final answer\\" src"}}',
        '{"action":"finish","output":"final answer"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner', stderr: '' },
        'rg -n "final answer" src': { exitCode: 0, stdout: 'final answer', stderr: '' },
      },
      logger: {
        write(event) {
          events.push(event);
        },
      },
    }
  );

  const switchEvent = events.find((event) => event.kind === 'turn_thinking_mode_switched');
  assert.equal(Boolean(switchEvent), true);
  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 4);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, false);
  assert.equal(turnRequests[2].thinkingEnabled, true);
  assert.equal(turnRequests[3].thinkingEnabled, true);
  const validationRequests = events.filter((event) => event.kind === 'turn_finish_validation_requested');
  assert.equal(validationRequests.length, 1);
  const skippedValidation = events.find((event) => event.kind === 'turn_finish_validation_skipped');
  assert.equal(Boolean(skippedValidation), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'final answer');
});

test('runTaskLoop counts malformed validation response toward invalid response limit', async () => {
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

test('runTaskLoop keeps thinking on and can still hit max turns after validation failure', async () => {
  const events = [];
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
      mockResponses: [
        '{"action":"finish","output":"first answer"}',
        '{"verdict":"fail","reason":"need more evidence"}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner', stderr: '' },
      },
      logger: {
        write(event) {
          events.push(event);
        },
      },
    }
  );

  const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
  assert.equal(turnRequests.length, 3);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(turnRequests[1].thinkingEnabled, true);
  assert.equal(turnRequests[2].thinkingEnabled, true);
  assert.equal(result.reason, 'max_turns');
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
  assert.equal(String(result.commands[1].reason || ''), 'Exact command was already executed');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop forces finish mode after ten zero-output commands', async () => {
  const events = [];
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
        write(event) {
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
  const events = [];
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
        write(event) {
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
