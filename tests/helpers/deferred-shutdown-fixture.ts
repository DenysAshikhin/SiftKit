import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfigPath } from '../../src/config/index.ts';
import { getRuntimeDatabasePath } from '../../src/state/runtime-db.ts';
import { writeConfig } from '../../src/status-server/config-store.ts';
import { InferenceRunFlushQueue } from '../../src/status-server/inference-run-flush-queue.ts';
import { getRuntimeRoot } from '../../src/status-server/paths.ts';
import { clearIdleSummaryTimer } from '../../src/status-server/server-ops.ts';
import type { ServerContext } from '../../src/status-server/server-types.ts';
import { createTestServerContext } from './server-context-fixture.ts';
import { IsolatedRuntime } from './isolated-runtime.ts';
import { getDefaultServerConfig } from './mock-config.ts';

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
export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
  note?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition still false after ${timeoutMs}ms${note === undefined ? '' : `: ${note}`}`);
    }
    await delay(10);
  }
}