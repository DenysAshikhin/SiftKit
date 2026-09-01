import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { runTaskLoop } from '../src/repo-search/engine.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { JsonObjectSchema } from '../src/lib/json-types.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import type { LlamaCppToolDefinition } from '../src/llm-protocol/types.js';
import type { PlannerToolDefinition } from '../src/planner-protocol/json-schema.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';

/**
 * Wildly divergent from any prompt this loop can build, so a re-introduced
 * predicted-vs-server drift check could not stay under its warn threshold.
 */
const SERVER_REPORTED_PROMPT_TOKENS = 500_000;

type LoopRun = {
  promptTokens: number;
  events: RepoSearchProgressEvent[];
  logged: Record<string, JsonSerializable>[];
};

/**
 * Lifts wire-level tool definitions into the loop's planner definitions. The mock
 * responses in this file never emit tool calls, so the permissive argument schema is
 * never exercised; only the wire rendering (name, description, parameters) matters.
 */
function toPlannerToolDefinitions(tools: readonly LlamaCppToolDefinition[]): PlannerToolDefinition[] {
  return tools.map((tool) => ({
    kind: 'tool',
    type: 'function',
    argumentSchema: JsonObjectSchema,
    exampleArgs: {},
    function: tool.function,
  }));
}

async function runOneTurnAgainstServer(options: { plannerTools?: readonly LlamaCppToolDefinition[] } = {}): Promise<LoopRun> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/tokenize') {
        const parsed = asObject(parseJsonValueText(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.max(1, Math.ceil(String(parsed.content || '').length / 4)) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        sendChatCompletionSse(res, {
          choices: [{ message: { role: 'assistant', content: '{"action":"finish","output":"done"}' } }],
          usage: {
            prompt_tokens: SERVER_REPORTED_PROMPT_TOKENS,
            completion_tokens: 4,
            total_tokens: SERVER_REPORTED_PROMPT_TOKENS + 4,
          },
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const plannerToolDefinitions = options.plannerTools === undefined
    ? resolveRepoSearchPlannerToolDefinitions()
    : toPlannerToolDefinitions(options.plannerTools);

  const events: RepoSearchProgressEvent[] = [];
  const logged: Record<string, JsonSerializable>[] = [];
  try {
    const result = await runTaskLoop(
      { id: 'prompt-accounting', question: 'Finish immediately.' },
      {
        plannerToolDefinitions,
        repoRoot: createManagedTempDir('siftkit-prompt-accounting-'),
        model: 'mock-model',
        baseUrl,
        runtimeProfile: new RepoSearchRuntimeProfile('repo-search'),
        systemContext: createEmptyPresetSystemContext(),
        config: mockSiftConfig({ Runtime: { LlamaCpp: { BaseUrl: baseUrl, NumCtx: 32_000 } } }),
        maxTurns: 2,
        minToolCallsBeforeFinish: 0,
        mockCommandResults: {},
        progressWriter: new CollectingProgressWriter<RepoSearchProgressEvent>(events),
        logger: {
          path: 'memory',
          write(event: Record<string, JsonSerializable>): void { logged.push(event); },
        },
      },
    );
    return { promptTokens: result.promptTokens, events, logged };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a turn whose server prompt count diverges emits no drift record and no context warning', async () => {
  const run = await runOneTurnAgainstServer();

  // The predicted-vs-server drift check was removed deliberately: the predicted count
  // carried a request-envelope reserve that made it warn on every turn. Re-adding it
  // against this server, which reports a half-million-token prompt, would fire here.
  assert.deepEqual(run.logged.filter((event) => event.kind === 'turn_prompt_drift'), []);
  assert.deepEqual(run.events.filter((event) => event.kind === 'context_warning'), []);
});

test('reported prompt tokens are the full wire prompt count', async () => {
  const run = await runOneTurnAgainstServer();

  const budgetEvents = run.logged.filter((event) => event.kind === 'turn_preflight_budget');
  assert.equal(budgetEvents.length, 1, 'the run must take exactly one turn for this sum to be exact');
  const budget: JsonObject = JSON.parse(JSON.stringify(budgetEvents[0]));
  assert.equal(run.promptTokens, Number(budget.promptTokenCount));
  // The server's own figure is never adopted as the prompt size.
  assert.notEqual(run.promptTokens, SERVER_REPORTED_PROMPT_TOKENS);
});

test('adding a planner tool raises the reported prompt token count', async () => {
  const withoutTools = await runOneTurnAgainstServer({ plannerTools: [] });
  const withTools = await runOneTurnAgainstServer({
    plannerTools: [{
      type: 'function',
      function: {
        name: 'grep',
        description: 'search the repository',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
      },
    }],
  });

  assert.ok(
    withTools.promptTokens > withoutTools.promptTokens,
    `tool schemas must be counted: ${withTools.promptTokens} vs ${withoutTools.promptTokens}`,
  );
});
