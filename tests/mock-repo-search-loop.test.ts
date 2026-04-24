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
      mockResponses: ['oops', 'still bad', 'Synthesized best-effort answer.'],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'invalid_response_limit');
  assert.equal(result.invalidResponses, 2);
  assert.equal(result.commands.length, 0);
  assert.equal(result.finalOutput, 'Synthesized best-effort answer.');
});

test('runTaskLoop replays recoverable invalid planner payloads as tool-call tool-result pairs', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-invalid-recoverable-tool-replay',
      question: 'Any question.',
      signals: ['done'],
    },
    {
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"planner\\" src"}',
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

  const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const turn2Messages = Array.isArray(turn2NewMessages?.messages) ? turn2NewMessages.messages : [];
  const assistantMessage = turn2Messages.find((message: { role?: string }) => message.role === 'assistant');
  const toolMessage = turn2Messages.find((message: { role?: string }) => message.role === 'tool');
  const userMessages = turn2Messages.filter((message: { role?: string }) => message.role === 'user');
  const assistantToolCall = Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls[0] : null;

  assert.equal(result.reason, 'finish');
  assert.equal(String(assistantToolCall?.function?.name || ''), 'repo_rg');
  assert.equal(JSON.parse(String(assistantToolCall?.function?.arguments || '{}')).command, 'rg -n "planner" src');
  assert.match(String(toolMessage?.content || ''), /Provider returned an invalid planner payload/u);
  assert.equal(userMessages.length, 0);
});

test('runTaskLoop replays unrecoverable invalid planner payloads through invalid_tool_call', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-invalid-fallback-tool-replay',
      question: 'Any question.',
      signals: ['done'],
    },
    {
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
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    }
  );

  const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const turn2Messages = Array.isArray(turn2NewMessages?.messages) ? turn2NewMessages.messages : [];
  const assistantMessage = turn2Messages.find((message: { role?: string }) => message.role === 'assistant');
  const toolMessage = turn2Messages.find((message: { role?: string }) => message.role === 'tool');
  const userMessages = turn2Messages.filter((message: { role?: string }) => message.role === 'user');
  const assistantToolCall = Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls[0] : null;
  const assistantArgs = JSON.parse(String(assistantToolCall?.function?.arguments || '{}'));

  assert.equal(result.reason, 'finish');
  assert.equal(String(assistantToolCall?.function?.name || ''), 'invalid_tool_call');
  assert.equal(String(assistantArgs?.rawResponseText || ''), 'oops');
  assert.match(String(toolMessage?.content || ''), /Provider returned an invalid planner payload/u);
  assert.equal(userMessages.length, 0);
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
      maxTurns: 10,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 7000,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" lib"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" test"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" docs"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" scripts"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" examples"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" fixtures"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'a '.repeat(500), stderr: '' },
        'rg -n "planner" lib': { exitCode: 0, stdout: 'b '.repeat(500), stderr: '' },
        'rg -n "planner" test': { exitCode: 0, stdout: 'c '.repeat(500), stderr: '' },
        'rg -n "planner" docs': { exitCode: 0, stdout: 'd '.repeat(500), stderr: '' },
        'rg -n "planner" scripts': { exitCode: 0, stdout: 'e '.repeat(500), stderr: '' },
        'rg -n "planner" examples': { exitCode: 0, stdout: 'f '.repeat(320), stderr: '' },
        'rg -n "planner" fixtures': { exitCode: 0, stdout: 'g '.repeat(320), stderr: '' },
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
  const oversizedQuestion = 'Q'.repeat(84000);
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

test('runTaskLoop accepts first finish immediately when runtime reasoning is off', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-finish-no-reasoning',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      config: {
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
            Reasoning: 'off',
          },
        },
      },
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"finish","output":"first finish"}',
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
  assert.equal(turnRequests.length, 1);
  assert.equal(turnRequests[0].thinkingEnabled, false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_followup'), false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_auto_accepted'), false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'first finish');
  assert.equal(result.invalidResponses, 0);
});

test('runTaskLoop accepts first finish immediately when runtime reasoning is on', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-finish-with-reasoning',
      question: 'Find planner text.',
      signals: ['final answer'],
    },
    {
      config: {
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
            Reasoning: 'on',
          },
        },
      },
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"finish","output":"final answer"}',
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
  assert.equal(turnRequests.length, 1);
  assert.equal(turnRequests[0].thinkingEnabled, true);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_followup'), false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_auto_accepted'), false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'final answer');
});

test('runTaskLoop does not emit follow-up finish events after many reasoning-off tool calls', async () => {
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
      id: 'task-finish-many-tools-no-followup',
      question: 'Find planner text.',
      signals: ['src\\target.ts:10'],
    },
    {
      config: {
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
            Reasoning: 'off',
          },
        },
      },
      maxTurns: 11,
      maxInvalidResponses: 2,
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
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-max-turns-no-reasoning',
      question: 'Find planner text.',
      signals: ['never-hits'],
    },
    {
      config: {
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
            Reasoning: 'off',
          },
        },
      },
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner2\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"planner3\\" src"}}',
        'Synthesized best-effort answer.',
      ],
      mockCommandResults: {
        'rg -n "planner" src': { exitCode: 0, stdout: 'planner', stderr: '' },
        'rg -n "planner2" src': { exitCode: 0, stdout: 'planner2', stderr: '' },
        'rg -n "planner3" src': { exitCode: 0, stdout: 'planner3', stderr: '' },
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
  assert.equal(turnRequests[2].thinkingEnabled, false);
  assert.equal(events.some((event) => event.kind === 'turn_non_thinking_finish_followup'), false);
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
    // Verify the engine still tracks the configured binary reasoning mode in logged events.
    const turnRequests = events.filter((event) => event.kind === 'turn_model_request');
    assert.equal(turnRequests.length >= 5, true);
    assert.equal(Boolean(turnRequests[0]?.thinkingEnabled), false);
    assert.equal(Boolean(turnRequests[3]?.thinkingEnabled), false);
    assert.equal(Boolean(turnRequests[4]?.thinkingEnabled), false);
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
        'rg -n "planner" src': { exitCode: 0, stdout: 'src\\planner.ts:10: planner hit', stderr: '' },
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

test('runTaskLoop keeps normalized rg rewrites out of model-visible tool replay and tool output', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-hide-normalized-rg-command-from-model',
      question: 'Find sendStatusUpdate.',
      signals: ['done'],
    },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"sendStatusUpdate\\" src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'rg -n "sendStatusUpdate" src': {
          exitCode: 1,
          stdout: '',
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
  assert.match(String(commandEvent?.insertedResultText || ''), /(?:^|\n)exit_code=1$/u);
  const turn2NewMessages = events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2);
  const turn2AssistantMessages = Array.isArray(turn2NewMessages?.messages)
    ? turn2NewMessages.messages.filter((message: { role?: string }) => message.role === 'assistant')
    : [];
  const replayedAssistantAction = turn2AssistantMessages[turn2AssistantMessages.length - 1]?.tool_calls?.[0];
  const replayedAssistantArgs = JSON.parse(String(replayedAssistantAction?.function?.arguments || '{}'));
  assert.equal(String(replayedAssistantArgs?.command || ''), 'rg -n "sendStatusUpdate" src');
  assert.doesNotMatch(String(replayedAssistantArgs?.command || ''), /--no-ignore/u);
  assert.doesNotMatch(String(replayedAssistantArgs?.command || ''), /--glob/u);
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
  const replayedAssistantAction = turn3AssistantMessages[turn3AssistantMessages.length - 1]?.tool_calls?.[0];
  assert.equal(String(replayedAssistantAction?.function?.name || ''), 'repo_get_content');
  const replayedAssistantArgs = JSON.parse(String(replayedAssistantAction?.function?.arguments || '{}'));
  assert.equal(String(replayedAssistantArgs?.command || ''), String(commandEvents[1]?.executedCommand || ''));
  assert.notEqual(String(replayedAssistantArgs?.command || ''), String(commandEvents[1]?.requestedCommand || ''));
  const turn3ToolMessages = Array.isArray(turn3NewMessages?.messages)
    ? turn3NewMessages.messages.filter((message: { role?: string }) => message.role === 'tool')
    : [];
  const replayedToolResultForPrompt = String(turn3ToolMessages[turn3ToolMessages.length - 1]?.content || '');
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

test('runTaskLoop does not compact different commands that happen to return the same evidence', async () => {
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
  assert.equal(Array.isArray(turn3NewMessages?.messages) ? turn3NewMessages.messages.length : -1, 2);

  const forcedStart = events.find((event) => event.kind === 'turn_forced_finish_mode_started' && event.trigger === 'no_new_evidence');
  assert.equal(Boolean(forcedStart), false);
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
  assert.equal(turn11Request.thinkingEnabled, false);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'forced conclusion');
});

test('runTaskLoop enables thinking on every tool-call turn when runtime reasoning is on', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-third-cadence',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      config: {
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
            Reasoning: 'on',
          },
        },
      },
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
  assert.equal(turnRequests[0].thinkingEnabled, true);
  assert.equal(turnRequests[1].thinkingEnabled, true);
  assert.equal(turnRequests[2].thinkingEnabled, true);
  assert.equal(turnRequests[3].thinkingEnabled, true);
  assert.equal(turnRequests[4].thinkingEnabled, true);
  assert.equal(turnRequests[5].thinkingEnabled, true);
  assert.equal(result.reason, 'finish');
});

test('runTaskLoop disables thinking on every tool-call turn when runtime reasoning is off', async () => {
  const events: Array<Record<string, unknown> & { kind: string }> = [];
  const result = await runTaskLoop(
    {
      id: 'task-no-thinking',
      question: 'Find planner text.',
      signals: ['done'],
    },
    {
      config: {
        Runtime: {
          LlamaCpp: {
            NumCtx: 32000,
            Reasoning: 'off',
          },
        },
      },
      maxTurns: 3,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"a\\" src"}}',
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"b\\" src"}}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "a" src': { exitCode: 0, stdout: 'a', stderr: '' },
        'rg -n "b" src': { exitCode: 0, stdout: 'b', stderr: '' },
      },
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
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
