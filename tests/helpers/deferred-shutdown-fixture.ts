import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfigPath } from '../../src/config/index.js';
import { getRuntimeDatabasePath } from '../../src/state/runtime-db.js';
import { writeConfig } from '../../src/status-server/config-store.js';
import { InferenceRunFlushQueue } from '../../src/status-server/inference-run-flush-queue.js';
import { getRuntimeRoot } from '../../src/status-server/paths.js';
import { clearIdleSummaryTimer } from '../../src/status-server/server-ops.js';
import type { ServerContext } from '../../src/status-server/server-types.js';
import { createTestServerContext } from './server-context-fixture.js';
import { IsolatedRuntime } from './isolated-runtime.js';
import { getDefaultServerConfig } from './mock-config.js';

/** A context whose normal drains would wait far longer than any shutdown budget. */
export function createDeferredContext(t: TestContext, idleDelayMs: number): { ctx: ServerContext; runtime: IsolatedRuntime } {
  const runtime = new IsolatedRuntime();
  runtime.start();
  const configPath = getConfigPath();
  writeConfig(configPath, getDefaultServerConfig());
  const base = createTestServerContext(configPath, getRuntimeRoot());
  const nowMs = Date.now();
  const ctx: ServerContext = {
    ...base,
    metricsPath: getRuntimeDatabasePath(),
    inferenceRunFlushQueue: new InferenceRunFlushQueue({ idleDelayMs }),
    terminalMetadata: { ...base.terminalMetadata, idleDelayMs, serverStartedAtMs: nowMs, lastModelRequestFinishedAtMs: nowMs },
  };
  t.after(async () => {
    clearIdleSummaryTimer(ctx);
    await ctx.inferenceRunFlushQueue.close();
    await runtime.close();
  });
  return { ctx, runtime };
}

/** A completed-run status body, addressed to `requestId`, carrying a token total to persist. */
export function completionBody(requestId: string): string {
  return JSON.stringify({ requestId, running: false, terminalState: 'completed', taskKind: 'summary', outputTokens: 7, inputTokens: 3 });
}

/** Polls a condition the production code drives on its own timers, e.g. a deferred drain. */
export async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition still false after ${timeoutMs}ms`);
    }
    await delay(10);
  }
}