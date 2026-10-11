import test from 'node:test';
import assert from 'node:assert/strict';

import { getActiveModelPreset } from '../src/config/getters.ts';
import { startStubStatusServer } from './_runtime-helpers.ts';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.ts';
import { requestSse } from './helpers/sse-http.ts';

const FINISH_CONTENT = '{"action":"finish","output":"done"}';
const HOLD_TIMEOUT_MS = 1000;

/** Runs two repo-searches at once through the real status server; returns the peak engine-side overlap. */
async function peakEngineConcurrency(prefix: string, parallelSlots: number): Promise<number> {
  const engine = await startStubStatusServer({
    tokenizeCharsPerToken: 4,
    assistantContent: () => FINISH_CONTENT,
    holdChatUntilConcurrent: { count: 2, timeoutMs: HOLD_TIMEOUT_MS },
  });
  const model = getActiveModelPreset(engine.state.config).Model;
  assert.ok(model);
  const server = await DashboardTestServer.start(prefix, {
    baseUrl: `http://127.0.0.1:${engine.port}`,
    model,
    parallelSlots,
  });
  try {
    const searches = ['first parallel search', 'second parallel search'].map((prompt) => requestSse(
      `${server.baseUrl}/repo-search`,
      { body: { prompt, repoRoot: process.cwd(), model, maxTurns: 1 }, timeoutMs: 30_000 },
    ));
    for (const search of await Promise.all(searches)) {
      assert.equal(search.statusCode, 200);
      assert.equal(search.errorMessage, null, search.rawBody);
    }
    return engine.state.maxActiveChatRequests;
  } finally {
    await server.close();
    await engine.close();
  }
}

test('two repo-searches generate concurrently on the engine when the preset has two slots', async () => {
  assert.equal(await peakEngineConcurrency('siftkit-parallel-two-slots-', 2), 2);
});

test('two repo-searches reach the engine one at a time when the preset has one slot', async () => {
  assert.equal(await peakEngineConcurrency('siftkit-parallel-one-slot-', 1), 1);
});
