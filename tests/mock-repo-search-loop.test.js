const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

test('parsePlannerAction recovers malformed escaped command payloads', () => {
  const malformed = '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"D:\\\\\\\\|C:\\\\\\\\|\\\\\\\\\\\\\\\\" src --type ts | Select-Object -First 30"}}';
  const action = parsePlannerAction(malformed);
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'run_repo_cmd',
    args: { command: 'rg -n "D:\\\\|C:\\\\|\\\\\\\\" src --type ts | Select-Object -First 30' },
  });
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
  assert.match(String(commandResult.output || ''), /rewrote --type tsx to --glob/u);
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
  assert.match(String(commandResult.output || ''), /rewrote --type tsx to --glob/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.commandFailures, 0);
  assert.equal(result.passed, true);
});

test('runTaskLoop reports prompt tokens and elapsed time on command progress events', async () => {
  const progressEvents = [];
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
      onProgress(event) {
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
  const events = [];
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
          write(event) {
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

test('runTaskLoop prompt omits visible tool-call budget counters', async () => {
  const events = [];
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
        write(event) {
          events.push(event);
        },
      },
    }
  );

  const prompts = events.filter((event) => event.kind === 'turn_prompt').map((event) => String(event.prompt || ''));
  assert.equal(prompts.length >= 3, true);
  assert.doesNotMatch(prompts[0], /Tool-call budget remaining:/u);
  assert.doesNotMatch(prompts[1], /Tool-call budget remaining:/u);
  assert.doesNotMatch(prompts[2], /Tool-call budget remaining:/u);
  assert.equal(result.reason, 'finish');
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
    assert.equal(Array.isArray(chatRequests[0].tools), true);
    assert.equal(chatRequests[0].tools[0]?.function?.name, 'run_repo_cmd');
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
  const events = [];
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
        write(event) {
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

test('runTaskLoop increases per-tool cap as tool-call progress grows', async () => {
  const events = [];
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
        write(event) {
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
  const events = [];
  const totalContextTokens = 20000;
  const oversizedQuestion = 'Q'.repeat(70000);
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
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': {
          exitCode: 0,
          stdout: 'x'.repeat(1200),
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
  assert.equal(commandEvent?.perToolCapTokens > commandEvent?.remainingTokenAllowance, true);
  assert.match(
    String(commandEvent?.insertedResultText || ''),
    /^Error: requested output would consume \d+ tokens, remaining token allowance: \d+, per tool call allowance: \d+$/u
  );
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop follows up once after non-thinking finish and then accepts thinking finish', async () => {
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
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"done"}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {},
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
  assert.equal(turnRequests[1].thinkingEnabled, true);

  const followupEvent = events.find((event) => event.kind === 'turn_non_thinking_finish_followup');
  assert.equal(Boolean(followupEvent), true);
  assert.equal(
    followupEvent.followupPrompt,
    'Are you sure you have enough evidence and did not get tunnel-visioned?'
  );

  const secondPrompt = events
    .filter((event) => event.kind === 'turn_prompt')
    .map((event) => String(event.prompt || ''))[1];
  assert.match(secondPrompt, /Are you sure you have enough evidence and did not get tunnel-visioned\?/u);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
});

test('runTaskLoop triggers non-thinking finish follow-up only once', async () => {
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
      enforceThinkingFinish: true,
      mockResponses: [
        '{"action":"finish","output":"final answer"}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"final answer\\" src"}}',
        '{"action":"finish","output":"final answer"}',
      ],
      mockCommandResults: {
        'rg -n "final answer" src': { exitCode: 0, stdout: 'final answer', stderr: '' },
      },
      logger: {
        write(event) {
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

test('runTaskLoop forces thinking on after non-thinking finish follow-up and can still hit max turns', async () => {
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
  assert.equal(turnRequests[2].thinkingEnabled, false);
  assert.equal(result.reason, 'max_turns');
});

test('runTaskLoop retries once on transient provider reset after thinking-mode switch', async () => {
  const events = [];
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
          write(event) {
            events.push(event);
          },
        },
      }
    );

    assert.equal(result.reason, 'finish');
    assert.equal(result.finalOutput, 'done');
    assert.equal(requestCount, 6);
    assert.equal(Boolean(requestBodies[0]?.extra_body?.reasoning_budget === 0), true);
    assert.equal(Boolean(requestBodies[1]?.chat_template_kwargs?.enable_thinking), false);
    assert.equal(Boolean(requestBodies[2]?.chat_template_kwargs?.enable_thinking), false);
    assert.equal(Boolean(requestBodies[3]?.chat_template_kwargs?.enable_thinking), false);
    assert.equal(Boolean(requestBodies[4]?.chat_template_kwargs?.enable_thinking), true);
    assert.equal(Boolean(requestBodies[5]?.chat_template_kwargs?.enable_thinking), true);
    const retryEvent = events.find((event) => event.kind === 'provider_request_retry');
    assert.equal(Boolean(retryEvent), true);
    assert.equal(retryEvent.turn, 5);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
