import test from 'node:test';
import assert from 'node:assert/strict';

import type { OptionalJsonValue } from '../src/lib/json-types.js';
import { getConfigPath } from '../src/config/index.js';
import { getActiveModelPreset, readConfig } from '../src/status-server/config-store.js';
import { queryDashboardRunsFromDb } from '../src/status-server/dashboard-runs/queries.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { requestJson, asObjectArray } from './helpers/dashboard-http.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';

function postRunning(baseUrl: string, requestId: string, taskKind: 'chat' | 'summary' = 'chat') {
  return requestJson(`${baseUrl}/status`, {
    method: 'POST',
    body: JSON.stringify({
      running: true,
      requestId,
      taskKind,
      rawInputCharacterCount: 10,
      promptCharacterCount: 20,
      promptTokenCount: 5,
    }),
  });
}

function postCompleted(baseUrl: string, requestId: string) {
  return requestJson(`${baseUrl}/status/complete`, {
    method: 'POST',
    body: JSON.stringify({
      requestId,
      terminalState: 'completed',
    }),
  });
}

function postTerminalMetadata(baseUrl: string, requestId: string) {
  return requestJson(`${baseUrl}/status/terminal-metadata`, {
    method: 'POST',
    body: JSON.stringify({
      running: false,
      requestId,
      terminalState: 'completed',
      taskKind: 'chat',
      promptCharacterCount: 20,
      promptTokenCount: 5,
      outputTokens: 10,
    }),
  });
}

function postMetadata(
  baseUrl: string,
  requestId: string,
  promptCharacterCount = 20,
  outputTokens = 10,
) {
  return requestJson(`${baseUrl}/status`, {
    method: 'POST',
    body: JSON.stringify({
      running: false,
      requestId,
      taskKind: 'chat',
      promptCharacterCount,
      promptTokenCount: 5,
      outputTokens,
    }),
  });
}

function getStatus(baseUrl: string) {
  return requestJson(`${baseUrl}/status`);
}

test('status endpoint tracks concurrent request ids sharing one path', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postRunning(server.baseUrl, 'request-b');
    const status = await getStatus(server.baseUrl);
    assert.deepEqual(
      asObjectArray(status.body.activeRuns).map((run) => run.requestId),
      ['request-a', 'request-b'],
    );
    assert.equal(status.body.running, true);
  } finally {
    await server.close();
  }
});

test('two CLI summaries and one dashboard request remain independently visible', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'cli-summary-a', 'summary');
    await postRunning(server.baseUrl, 'cli-summary-b', 'summary');
    await postRunning(server.baseUrl, 'dashboard-chat', 'chat');
    const status = await getStatus(server.baseUrl);
    const identities: Array<{ requestId: OptionalJsonValue; taskKind: OptionalJsonValue }> = [];
    for (const run of asObjectArray(status.body.activeRuns)) {
      identities.push({ requestId: run.requestId, taskKind: run.taskKind });
    }
    assert.deepEqual(identities, [
      { requestId: 'cli-summary-a', taskKind: 'summary' },
      { requestId: 'cli-summary-b', taskKind: 'summary' },
      { requestId: 'dashboard-chat', taskKind: 'chat' },
    ]);
  } finally {
    await server.close();
  }
});

test('out-of-order completion removes only the completing request', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postRunning(server.baseUrl, 'request-b');
    await postCompleted(server.baseUrl, 'request-b');
    const status = await getStatus(server.baseUrl);
    assert.deepEqual(
      asObjectArray(status.body.activeRuns).map((run) => run.requestId),
      ['request-a'],
    );
    assert.equal(status.body.running, true);
  } finally {
    await server.close();
  }
});

test('completion-before-running creates tombstone and does not affect active runs', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postCompleted(server.baseUrl, 'request-tombstone');
    await postRunning(server.baseUrl, 'request-a');
    const status = await getStatus(server.baseUrl);
    assert.deepEqual(
      asObjectArray(status.body.activeRuns).map((run) => run.requestId),
      ['request-a'],
    );
    assert.equal(status.body.running, true);
  } finally {
    await server.close();
  }
});

test('missing requestId returns 400 on POST /status', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    const response = await requestJson(`${server.baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({
        running: true,
        taskKind: 'chat',
      }),
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await server.close();
  }
});

test('missing requestId returns 400 on POST /status/complete', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    const response = await requestJson(`${server.baseUrl}/status/complete`, {
      method: 'POST',
      body: JSON.stringify({
        terminalState: 'completed',
      }),
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await server.close();
  }
});

test('exact-request late running update is suppressed after completion', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postCompleted(server.baseUrl, 'request-a');
    const lateResponse = await postRunning(server.baseUrl, 'request-a');
    assert.equal(lateResponse.statusCode, 200);
    const status = await getStatus(server.baseUrl);
    assert.equal(asObjectArray(status.body.activeRuns).length, 0);
    assert.equal(status.body.running, false);
  } finally {
    await server.close();
  }
});

test('metadata before completion preserves active run', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postMetadata(server.baseUrl, 'request-a', 50);
    const status = await getStatus(server.baseUrl);
    const runs = asObjectArray(status.body.activeRuns);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].requestId, 'request-a');
    assert.equal(runs[0].stepCount, 1);
  } finally {
    await server.close();
  }
});

test('metadata after completion is suppressed', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postCompleted(server.baseUrl, 'request-a');
    await postMetadata(server.baseUrl, 'request-a');
    const status = await getStatus(server.baseUrl);
    assert.equal(asObjectArray(status.body.activeRuns).length, 0);
    assert.equal(status.body.running, false);
  } finally {
    await server.close();
  }
});

test('duplicate terminal metadata is idempotent', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postCompleted(server.baseUrl, 'request-a');
    await postTerminalMetadata(server.baseUrl, 'request-a');
    await postTerminalMetadata(server.baseUrl, 'request-a');
    const status = await getStatus(server.baseUrl);
    assert.equal(asObjectArray(status.body.activeRuns).length, 0);
    assert.equal(status.body.running, false);
  } finally {
    await server.close();
  }
});

test('aggregate running is false only after last request completes', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postRunning(server.baseUrl, 'request-b');
    await postCompleted(server.baseUrl, 'request-a');
    const status1 = await getStatus(server.baseUrl);
    assert.equal(status1.body.running, true);
    await postCompleted(server.baseUrl, 'request-b');
    const status2 = await getStatus(server.baseUrl);
    assert.equal(status2.body.running, false);
  } finally {
    await server.close();
  }
});

test('activeRuns excludes sensitive fields', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    const status = await getStatus(server.baseUrl);
    const runs = asObjectArray(status.body.activeRuns);
    assert.equal(runs.length, 1);
    const run = runs[0];
    const sensitiveKeys = ['prompt', 'answer', 'image', 'credential', 'rawInput', 'rawInputCharacterCount', 'promptCharacterCount', 'promptTokenCount'];
    for (const key of sensitiveKeys) {
      assert.equal(key in run, false, `activeRuns entry must not contain ${key}`);
    }
  } finally {
    await server.close();
  }
});

test('metrics are counted once per request despite multiple posts', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postMetadata(server.baseUrl, 'request-a', 20, 5);
    await postMetadata(server.baseUrl, 'request-a', 20, 5);
    await postCompleted(server.baseUrl, 'request-a');
    await postTerminalMetadata(server.baseUrl, 'request-a');
    const metrics = await server.readSettledMetrics(1);
    assert.equal(metrics.completedRequestCount, 1);
  } finally {
    await server.close();
  }
});

async function assertStatus(
  baseUrl: string,
  requestIds: string[],
  running: boolean,
): Promise<void> {
  const status = await getStatus(baseUrl);
  assert.deepEqual(
    asObjectArray(status.body.activeRuns).map((run) => run.requestId),
    requestIds,
  );
  assert.equal(status.body.running, running);
}

type ExpectedPersistedRun = {
  status: 'completed' | 'failed';
  outputTokens: number;
};

function assertPersistedRuns(expected: Readonly<Record<string, ExpectedPersistedRun>>): void {
  const logs = queryDashboardRunsFromDb(getRuntimeDatabase());
  for (const [requestId, expectedRun] of Object.entries(expected)) {
    const matching = logs.filter((log) => log.id === requestId);
    assert.equal(matching.length, 1, 'expected one persisted log for ' + requestId);
    assert.equal(matching[0]?.status, expectedRun.status);
    assert.equal(matching[0]?.outputTokens, expectedRun.outputTokens);
  }
}

function postFailed(baseUrl: string, requestId: string) {
  return requestJson(baseUrl + '/status/complete', {
    method: 'POST',
    body: JSON.stringify({ requestId, terminalState: 'failed' }),
  });
}

function postFailedTerminalMetadata(baseUrl: string, requestId: string) {
  return requestJson(baseUrl + '/status/terminal-metadata', {
    method: 'POST',
    body: JSON.stringify({
      running: false,
      requestId,
      terminalState: 'failed',
      taskKind: 'chat',
      promptCharacterCount: 20,
      promptTokenCount: 5,
      outputTokens: 0,
    }),
  });
}

test('matrix: complete(A), metadata(A), complete(B), metadata(B)', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'matrix-a');
    await assertStatus(server.baseUrl, ['matrix-a'], true);
    await postRunning(server.baseUrl, 'matrix-b');
    await assertStatus(server.baseUrl, ['matrix-a', 'matrix-b'], true);
    await postCompleted(server.baseUrl, 'matrix-a');
    await assertStatus(server.baseUrl, ['matrix-b'], true);
    await postTerminalMetadata(server.baseUrl, 'matrix-a');
    await assertStatus(server.baseUrl, ['matrix-b'], true);
    await postCompleted(server.baseUrl, 'matrix-b');
    await assertStatus(server.baseUrl, [], false);
    await postTerminalMetadata(server.baseUrl, 'matrix-b');
    await assertStatus(server.baseUrl, [], false);

    const metrics = await server.readSettledMetrics(2);
    assert.equal(metrics.completedRequestCount, 2);
    assert.equal(metrics.taskTotals.chat.outputTokensTotal, 20);
    assertPersistedRuns({
      'matrix-a': { status: 'completed', outputTokens: 10 },
      'matrix-b': { status: 'completed', outputTokens: 10 },
    });
  } finally {
    await server.close();
  }
});

test('matrix: complete(B), complete(A), metadata(A), metadata(B)', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'reverse-a');
    await assertStatus(server.baseUrl, ['reverse-a'], true);
    await postRunning(server.baseUrl, 'reverse-b');
    await assertStatus(server.baseUrl, ['reverse-a', 'reverse-b'], true);
    await postCompleted(server.baseUrl, 'reverse-b');
    await assertStatus(server.baseUrl, ['reverse-a'], true);
    await postCompleted(server.baseUrl, 'reverse-a');
    await assertStatus(server.baseUrl, [], false);
    await postTerminalMetadata(server.baseUrl, 'reverse-a');
    await assertStatus(server.baseUrl, [], false);
    await postTerminalMetadata(server.baseUrl, 'reverse-b');
    await assertStatus(server.baseUrl, [], false);

    const metrics = await server.readSettledMetrics(2);
    assert.equal(metrics.completedRequestCount, 2);
    assert.equal(metrics.taskTotals.chat.outputTokensTotal, 20);
    assertPersistedRuns({
      'reverse-a': { status: 'completed', outputTokens: 10 },
      'reverse-b': { status: 'completed', outputTokens: 10 },
    });
  } finally {
    await server.close();
  }
});

test('matrix: metadata(A), complete(A), duplicate metadata(A)', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'duplicate-a');
    await assertStatus(server.baseUrl, ['duplicate-a'], true);
    await postMetadata(server.baseUrl, 'duplicate-a', 30, 8);
    await assertStatus(server.baseUrl, ['duplicate-a'], true);
    await postCompleted(server.baseUrl, 'duplicate-a');
    await assertStatus(server.baseUrl, [], false);
    await postTerminalMetadata(server.baseUrl, 'duplicate-a');
    await assertStatus(server.baseUrl, [], false);
    await postTerminalMetadata(server.baseUrl, 'duplicate-a');
    await assertStatus(server.baseUrl, [], false);

    const metrics = await server.readSettledMetrics(1);
    assert.equal(metrics.completedRequestCount, 1);
    assert.equal(metrics.taskTotals.chat.outputTokensTotal, 18);
    assertPersistedRuns({ 'duplicate-a': { status: 'completed', outputTokens: 18 } });
  } finally {
    await server.close();
  }
});

test('matrix: failure(A), success(B)', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'failure-a');
    await assertStatus(server.baseUrl, ['failure-a'], true);
    await postRunning(server.baseUrl, 'success-b');
    await assertStatus(server.baseUrl, ['failure-a', 'success-b'], true);
    await postFailed(server.baseUrl, 'failure-a');
    await assertStatus(server.baseUrl, ['success-b'], true);
    await postFailedTerminalMetadata(server.baseUrl, 'failure-a');
    await assertStatus(server.baseUrl, ['success-b'], true);
    await postCompleted(server.baseUrl, 'success-b');
    await assertStatus(server.baseUrl, [], false);
    await postTerminalMetadata(server.baseUrl, 'success-b');
    await assertStatus(server.baseUrl, [], false);

    const metrics = await server.readSettledMetrics(1);
    assert.equal(metrics.completedRequestCount, 1);
    assert.equal(metrics.taskTotals.chat.outputTokensTotal, 10);
    assertPersistedRuns({
      'failure-a': { status: 'failed', outputTokens: 0 },
      'success-b': { status: 'completed', outputTokens: 10 },
    });
  } finally {
    await server.close();
  }
});

test('matrix: disconnect(A), retry(A), concurrent success(B)', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'retry-a');
    await assertStatus(server.baseUrl, ['retry-a'], true);
    await postRunning(server.baseUrl, 'concurrent-b');
    await assertStatus(server.baseUrl, ['retry-a', 'concurrent-b'], true);
    await postCompleted(server.baseUrl, 'retry-a');
    await assertStatus(server.baseUrl, ['concurrent-b'], true);
    const retry = await postRunning(server.baseUrl, 'retry-a');
    assert.equal(retry.statusCode, 200);
    await assertStatus(server.baseUrl, ['concurrent-b'], true);
    await postTerminalMetadata(server.baseUrl, 'retry-a');
    await assertStatus(server.baseUrl, ['concurrent-b'], true);
    await postCompleted(server.baseUrl, 'concurrent-b');
    await assertStatus(server.baseUrl, [], false);
    await postTerminalMetadata(server.baseUrl, 'concurrent-b');
    await assertStatus(server.baseUrl, [], false);

    const metrics = await server.readSettledMetrics(2);
    assert.equal(metrics.completedRequestCount, 2);
    assert.equal(metrics.taskTotals.chat.outputTokensTotal, 20);
    assertPersistedRuns({
      'retry-a': { status: 'completed', outputTokens: 10 },
      'concurrent-b': { status: 'completed', outputTokens: 10 },
    });
  } finally {
    await server.close();
  }
});

function readActivePresetIdentity(): { model: string | null; backend: string } {
  const preset = getActiveModelPreset(readConfig(getConfigPath()));
  return { model: preset.Model, backend: preset.Backend };
}

test('completed status run logs record the active preset model, backend, and title', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'identity-a');
    await postCompleted(server.baseUrl, 'identity-a');
    await postTerminalMetadata(server.baseUrl, 'identity-a');
    await server.readSettledMetrics(1);

    const expected = readActivePresetIdentity();
    const logs = queryDashboardRunsFromDb(getRuntimeDatabase());
    const matching = logs.filter((log) => log.id === 'identity-a');
    assert.equal(matching.length, 1, 'expected one persisted log for identity-a');
    assert.equal(matching[0]?.backend, expected.backend);
    assert.equal(matching[0]?.model, expected.model);
    assert.equal(matching[0]?.title, 'chat identity-a');
  } finally {
    await server.close();
  }
});

test('a status run with no task kind is titled from the status fallback', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await requestJson(`${server.baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({ running: true, requestId: 'identity-b' }),
    });
    await postCompleted(server.baseUrl, 'identity-b');
    await requestJson(`${server.baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      body: JSON.stringify({ running: false, requestId: 'identity-b', terminalState: 'completed', outputTokens: 1 }),
    });
    await server.readSettledMetrics(1);

    const logs = queryDashboardRunsFromDb(getRuntimeDatabase());
    const matching = logs.filter((log) => log.id === 'identity-b');
    assert.equal(matching.length, 1, 'expected one persisted log for identity-b');
    assert.equal(matching[0]?.title, 'status identity-b');
  } finally {
    await server.close();
  }
});
