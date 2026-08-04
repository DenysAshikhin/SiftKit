import test from 'node:test';
import assert from 'node:assert/strict';

import { requestJson, asObjectArray } from './helpers/dashboard-http.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';

function postRunning(baseUrl: string, requestId: string) {
  return requestJson(`${baseUrl}/status`, {
    method: 'POST',
    body: JSON.stringify({
      running: true,
      requestId,
      taskKind: 'chat',
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
