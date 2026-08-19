import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { waitForTerminalMetadataIdle } from '../src/status-server/terminal-metadata.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import { testHttpAgent } from './helpers/http-agent.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('terminal metadata idle wait observes scheduled work completing', async () => {
  const tempRoot = createManagedTempDir('siftkit-terminal-metadata-idle-');
  const context = createTestServerContext(path.join(tempRoot, 'config.json'));
  context.terminalMetadata.queue.push({
    requestId: 'request-delayed',
    terminalState: 'completed',
    bodyText: '{}',
    capturedAtMs: Date.now(),
  });
  context.terminalMetadata.drainScheduled = true;
  const completion = setTimeout(() => {
    context.terminalMetadata.queue.length = 0;
    context.terminalMetadata.drainScheduled = false;
  }, 20);
  try {
    await waitForTerminalMetadataIdle(context, 100);
  } finally {
    clearTimeout(completion);
    await context.inferenceRunFlushQueue.close();
  }
});

test('terminal metadata idle wait reports stuck queue state at its ceiling', async () => {
  const tempRoot = createManagedTempDir('siftkit-terminal-metadata-stuck-');
  const context = createTestServerContext(path.join(tempRoot, 'config.json'));
  context.terminalMetadata.queue.push({
    requestId: 'request-stuck',
    terminalState: 'failed',
    bodyText: '{}',
    capturedAtMs: Date.now(),
  });
  context.terminalMetadata.drainRunning = true;
  try {
    await assert.rejects(
      waitForTerminalMetadataIdle(context, 25),
      /queue=1 scheduled=false running=true request=request-stuck/u,
    );
  } finally {
    await context.inferenceRunFlushQueue.close();
  }
});

function openBenchmarkEventStream(baseUrl: string): {
  started: Promise<void>;
  settled: Promise<void>;
  abort: () => void;
} {
  const startDeadlineMs = 5_000;
  let startDeadline: NodeJS.Timeout | null = null;
  let resolveStarted = (): void => {};
  let rejectStarted = (_error: Error): void => {};
  let resolveSettled = (): void => {};
  let hasStarted = false;
  let hasSettled = false;
  const clearStartDeadline = (): void => {
    if (startDeadline !== null) {
      clearTimeout(startDeadline);
      startDeadline = null;
    }
  };
  const startedPromise = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = (error) => {
      if (!hasStarted) {
        hasStarted = true;
        reject(error);
      }
    };
  });
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const request = http.get(
    `${baseUrl}/dashboard/benchmark/sessions/leak-regression/events`,
    { agent: testHttpAgent },
    (response) => {
      clearStartDeadline();
      response.resume();
      hasStarted = true;
      resolveStarted();
      const settle = (): void => {
        if (!hasSettled) {
          hasSettled = true;
          resolveSettled();
        }
      };
      response.once('close', settle);
      response.once('end', settle);
      response.once('error', settle);
    },
  );
  startDeadline = setTimeout(() => {
    const error = new Error('benchmark stream request timed out before response headers');
    if (!hasSettled) {
      hasSettled = true;
      clearStartDeadline();
      rejectStarted(error);
      request.destroy(error);
      resolveSettled();
    }
  }, startDeadlineMs);
  startDeadline.unref();
  request.once('error', (error) => {
    clearStartDeadline();
    rejectStarted(error);
    if (!hasSettled) {
      hasSettled = true;
      resolveSettled();
    }
  });
  return {
    started: startedPromise,
    settled: settledPromise,
    abort: () => request.destroy(),
  };
}

test('DashboardTestServer closes one active SSE stream exactly once', async () => {
  const fixture = await DashboardTestServer.start('siftkit-dashboard-close-');
  let stream: ReturnType<typeof openBenchmarkEventStream> | null = null;
  try {
    stream = openBenchmarkEventStream(fixture.baseUrl);
    await stream.started;
    const firstClose = fixture.close();
    const concurrentClose = fixture.close();
    const sharedConcurrentPromise = concurrentClose === firstClose;
    const allSettled = Promise.allSettled([firstClose, concurrentClose, stream.settled]);
    const closedPromptly = await Promise.race([
      allSettled.then(() => true),
      delay(2_000, false, { ref: false }),
    ]);
    if (!closedPromptly) {
      stream.abort();
      await allSettled;
    }

    const laterClose = fixture.close();
    const sharedLaterPromise = laterClose === firstClose;
    await firstClose;
    await concurrentClose;
    await laterClose;

    assert.equal(closedPromptly, true);
    assert.equal(sharedConcurrentPromise, true);
    assert.equal(sharedLaterPromise, true);
  } finally {
    if (stream !== null) {
      stream.abort();
    }
    await Promise.allSettled([fixture.close()]);
  }
});

test('DashboardTestServer rolls back cwd, env, and temp files when setup throws', async () => {
  const previousCwd = process.cwd();
  const previousStatusPort = process.env.SIFTKIT_STATUS_PORT;
  const prefix = `siftkit-dashboard-start-failure-${process.pid}-`;
  const backend = {
    baseUrl: DEAD_BASE_URL,
    get model(): string {
      throw new Error('forced backend setup failure');
    },
  };
  let cwdAfterFailure = '';
  let statusPortAfterFailure: string | undefined;
  let leftovers: string[] = [];
  try {
    await assert.rejects(DashboardTestServer.start(prefix, backend), /forced backend setup failure/u);
    cwdAfterFailure = process.cwd();
    statusPortAfterFailure = process.env.SIFTKIT_STATUS_PORT;
    leftovers = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(prefix));
  } finally {
    process.chdir(previousCwd);
    if (previousStatusPort === undefined) {
      delete process.env.SIFTKIT_STATUS_PORT;
    } else {
      process.env.SIFTKIT_STATUS_PORT = previousStatusPort;
    }
    for (const entry of leftovers) {
      fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  }

  assert.equal(cwdAfterFailure, previousCwd);
  assert.equal(statusPortAfterFailure, previousStatusPort);
  assert.deepEqual(leftovers, []);
});
