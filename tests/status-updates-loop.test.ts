import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';

import { runTaskLoop } from '../src/repo-search/engine.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import type { TaskResult } from '../src/repo-search/engine/task-loop-support.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.ts';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.ts';
import { z } from '../src/lib/zod.ts';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.ts';
import { getAddressInfo } from './helpers/dashboard-http.ts';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.ts';
import { IsolatedRuntime } from './helpers/isolated-runtime.ts';
import { mockSiftConfig } from './helpers/mock-config.ts';
import { buildTabbyUsage, sendChatCompletionSse } from './helpers/streaming-client.ts';
import { tabbyTokenEncodeResponse } from './helpers/tabby-token-encode.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';

const isolatedRuntime = new IsolatedRuntime();
before(() => isolatedRuntime.start());
after(() => isolatedRuntime.close());

const RequestSchema = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.json() })) });
const TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"command":"npm test"}' } };
type Reply = 'text' | 'tool' | 'error' | 'path' | 'hang';
type Run = { result: TaskResult; planner: string[]; plannerAtMs: number[]; statusRequests: number; shown: string[]; logged: JsonObject[] };

/** One run in `repoRoot`: a four-second check, then the answer. The engine answers a status request as `reply` says. */
async function run(repoRoot: string, statusUpdates: boolean, reply: Reply): Promise<Run> {
  const planner: string[] = [];
  const plannerAtMs: number[] = [];
  let statusRequests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/v1/token/encode') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tabbyTokenEncodeResponse(Math.ceil(body.length / 4))));
        return;
      }
      const last = RequestSchema.parse(parseJsonValueText(body)).messages.at(-1);
      if (typeof last?.content === 'string' && last.content.startsWith('This command is running now')) {
        statusRequests += 1;
        if (reply === 'hang') return;
        if (reply === 'error') {
          res.writeHead(500);
          res.end('broken');
          return;
        }
        const content = reply === 'path' ? 'Editing src/a.ts.' : 'Checking that the change holds.';
        sendChatCompletionSse(res, {
          choices: [{ message: { role: 'assistant', ...(reply === 'tool' ? { content: '', tool_calls: [TOOL_CALL] } : { content }) } }],
          usage: buildTabbyUsage({ promptTokens: 900, cachedTokens: 880, completionTokens: 8 }),
        });
        return;
      }
      planner.push(body);
      plannerAtMs.push(performance.now());
      sendChatCompletionSse(res, {
        choices: [{ message: { role: 'assistant', ...(planner.length === 1 ? { content: '', tool_calls: [TOOL_CALL] } : { content: 'done' }) } }],
        usage: buildTabbyUsage({ promptTokens: 1_000, cachedTokens: planner.length === 1 ? 0 : 950, completionTokens: 4 }),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const progress = new CollectingProgressWriter<RepoSearchProgressEvent>();
  const logged: JsonObject[] = [];
  try {
    const result = await runTaskLoop({ id: 'status', question: 'Check it.' }, {
      throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['run', 'read']),
      repoRoot, model: 'mock-model', baseUrl,
      runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'), systemContext: createEmptyPresetSystemContext(),
      config: mockSiftConfig({ Server: { ModelPresets: { Presets: [{ BaseUrl: baseUrl, NumCtx: 32_000 }] } } }),
      maxTurns: 4, minToolCallsBeforeFinish: 0, progressWriter: progress, statusUpdates,
      mockCommandResults: { 'run command="npm test"': { exitCode: 0, stdout: 'ok', stderr: '', delayMs: 4_000 } },
      logger: { path: 'memory', write(event) { logged.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event)))); } },
    });
    return { result, planner, plannerAtMs, statusRequests, logged, shown: progress.ofKind('status_update').map((event) => event.text) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** What the run leaves behind, without what a clock or a port decides. */
function trace(value: Run): JsonObject {
  const { promptTokens, outputTokens, thinkingTokens, promptCacheTokens, promptEvalTokens, reason, finalOutput, turnsUsed, throughput } = value.result;
  return JsonObjectSchema.parse(parseJsonValueText(JSON.stringify({
    promptTokens, outputTokens, thinkingTokens, promptCacheTokens, promptEvalTokens, reason, finalOutput, turnsUsed,
    requests: throughput.pp.requestCount, planner: value.planner,
    breaks: value.logged.filter((event) => event.kind === 'prompt_cache_break'),
    messages: value.logged.filter((event) => event.kind === 'turn_new_messages'),
  })));
}

test('a status update leaves the run exactly as it would have been', async () => {
  const root = createManagedTempDir('siftkit-status-updates-');
  const [off, shown, refused, calling, broken, hung] = await Promise.all([
    run(root, false, 'text'), run(root, true, 'text'), run(root, true, 'path'), run(root, true, 'tool'), run(root, true, 'error'), run(root, true, 'hang'),
  ]);
  assert.equal(off.statusRequests, 0);
  assert.equal(off.planner.length, 2);
  assert.deepEqual(shown.shown, ['Checking that the change holds.']);
  for (const updated of [shown, refused, calling, broken, hung]) {
    assert.equal(updated.statusRequests, 1);
    assert.deepEqual(trace(updated), trace(off));
  }
  for (const silent of [off, refused, calling, broken, hung]) assert.deepEqual(silent.shown, []);
  assert.deepEqual(shown.logged.filter((event) => event.kind === 'status_update').map((event) => [event.outcome, event.promptCacheTokens]), [['shown', 880]]);
  assert.deepEqual(hung.logged.filter((event) => event.kind === 'status_update').map((event) => event.outcome), ['cancelled']);
  // The hung request went with its command; the next planner request did not wait for it.
  const gap = (value: Run): number => (value.plannerAtMs[1] ?? 0) - (value.plannerAtMs[0] ?? 0);
  assert.ok(gap(hung) < gap(off) + 1_000, `${gap(hung)} against ${gap(off)} ms`);
});
