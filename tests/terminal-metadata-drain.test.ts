import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfigPath } from '../src/config/index.js';
import { getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { getRuntimeRoot } from '../src/status-server/paths.js';
import { clearIdleSummaryTimer } from '../src/status-server/server-ops.js';
import { parseStatusMetadata } from '../src/status-server/status-file.js';
import { scheduleDeferredTerminalMetadata, waitForTerminalMetadataIdle } from '../src/status-server/terminal-metadata.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';

test('terminal metadata idle waits for direct deferred jobs before releasing their runtime', async t => {
  const runtime = new IsolatedRuntime();
  runtime.start();
  const configPath = getConfigPath();
  writeConfig(configPath, getDefaultServerConfig());
  const ctx = { ...createTestServerContext(configPath, getRuntimeRoot()), metricsPath: getRuntimeDatabasePath() };
  t.after(async () => {
    await delay(50);
    clearIdleSummaryTimer(ctx);
    await ctx.inferenceRunFlushQueue.close();
    await runtime.close();
  });
  const now = new Date().toISOString();
  scheduleDeferredTerminalMetadata(ctx, {
    requestId: 'deferred-completion', metadata: parseStatusMetadata(JSON.stringify({
      requestId: 'deferred-completion', running: false, terminalState: 'completed', taskKind: 'chat', outputTokens: 7,
    })), startedAtUtc: now, finishedAtUtc: now, elapsedMs: 1, totalElapsedMs: 1,
    requestCompleted: true, suppressLogLine: true,
  });
  await waitForTerminalMetadataIdle(ctx, 1000);
  assert.equal(ctx.metrics.completedRequestCount, 1);
  assert.equal(ctx.metrics.outputTokensTotal, 7);
});
