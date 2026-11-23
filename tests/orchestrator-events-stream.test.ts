import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { OrchestratorProgressSchema, OrchestratorRunStateSchema, type OrchestratorRunState } from '@siftkit/contracts';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.ts';
import type { ServerContext } from '../src/status-server/server-types.ts';
import { OrchestratorEventsEndpoint } from '../src/status-server/routes/orchestrator.ts';
import { SSE_MAX_BUFFERED_BYTES } from '../src/status-server/sse-response-writer.ts';
import { withTempEnv } from './_runtime-helpers.ts';
import { FakeLiveRun } from './helpers/fake-orchestrator-live-run.ts';
import { makeOrchestratorRequest } from './helpers/orchestrator-plan.ts';
import { createTestServerContext } from './helpers/server-context-fixture.ts';
import { requestSse } from './helpers/sse-http.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const STREAM_TIMEOUT_MS = 30_000;

/** A live run of `task` behind a real HTTP server that serves only the events endpoint. */
async function serveRun(t: TestContext, task: string): Promise<{ ctx: ServerContext; state: OrchestratorRunState; url: string }> {
  const root = createManagedTempDir('siftkit-orchestrator-events-');
  const ctx = createTestServerContext(path.join(root, 'config.json'), root);
  t.after(() => closeAllRuntimeDatabases());
  const state = ctx.orchestratorRunStore.create(makeOrchestratorRequest({ repoRoot: root, approval: 'off', task }));
  ctx.orchestratorRuns.register(new FakeLiveRun(state.runId));
  const endpoint = new OrchestratorEventsEndpoint();
  const server = http.createServer((req, res) => {
    void endpoint.handle(ctx, req, res, { pathname: '/orchestrator/events', captures: [] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test server has no TCP address.');
  return { ctx, state, url: `http://127.0.0.1:${address.port}/orchestrator/events` };
}

// Real case (run 560566c3): every progress frame carries the whole run state, 558 KB once attempts piled up, and
// the stream dropped its client whenever two frames queued past the writer's buffer cap. This state outgrows the cap alone.
test('a burst of events over a run state bigger than the stream buffer reaches the client whole, then the result', async (t) => {
  const served = await serveRun(t, `Explain everything. ${'x'.repeat(SSE_MAX_BUFFERED_BYTES)}`);
  const { ctx } = served;
  let state = served.state;
  let burstSent = false;
  const response = await requestSse(served.url, {
    body: { runId: state.runId, afterSequence: 0 }, timeoutMs: STREAM_TIMEOUT_MS,
    // Once the client holds the first frame, four events commit in one tick, the way a child settles.
    onProgress: () => {
      if (burstSent) return;
      burstSent = true;
      for (const message of ['Executing the plan.', 'Settled implementation attempt 1: passed.', 'Task t: reviewing.']) {
        state = ctx.orchestratorRunStore.update(state.runId, state.revision, { phase: 'executing' }, { message });
        ctx.orchestratorRuns.publish(state);
      }
      state = ctx.orchestratorRunStore.update(state.runId, state.revision, { phase: 'completed' }, { message: 'Run completed.' });
      ctx.orchestratorRuns.publish(state);
    },
  });

  assert.equal(response.errorMessage, null, 'no error frame');
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > SSE_MAX_BUFFERED_BYTES, 'the state alone outgrows the stream buffer');
  assert.equal(OrchestratorRunStateSchema.parse(response.result).phase, 'completed', 'the result reaches the client');
  const events = response.progress.flatMap((frame) => OrchestratorProgressSchema.parse(frame).events);
  assert.deepEqual(events.map((event) => event.message),
    ['Orchestrator run created.', 'Executing the plan.', 'Settled implementation attempt 1: passed.', 'Task t: reviewing.', 'Run completed.'],
    'every event once, in order');
  assert.equal(response.progress.length, 2, 'the replay, then the whole burst in one frame rather than one frame per event');
});

// The server records the error in the runtime database of its working directory, so that one is a temporary one here.
test('a stream that cannot read its run any more ends with an error frame instead of hanging', async (t) => {
  await withTempEnv(async () => {
    const { ctx, state, url } = await serveRun(t, 'Inspect the README.');
    let broken = false;
    const response = await requestSse(url, {
      body: { runId: state.runId, afterSequence: 0 }, timeoutMs: STREAM_TIMEOUT_MS,
      onProgress: () => {
        if (broken) return;
        broken = true;
        closeAllRuntimeDatabases();
        ctx.orchestratorRuns.publish(state);
      },
    });

    assert.match(response.errorMessage ?? '', /database connection is not open/u, response.rawBody.slice(-500));
    assert.equal(response.result, null, 'no result follows the error');
  });
});
