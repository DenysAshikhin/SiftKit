const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { startStatusServer } = require('../siftKitStatus/index.js');

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseText += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: responseText ? JSON.parse(responseText) : {},
          });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(Number(options.timeoutMs || 4000), () => {
      request.destroy(new Error('request timeout'));
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function requestSse(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const events = [];
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const packet = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = packet
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean);
            const eventLine = lines.find((line) => line.startsWith('event:'));
            const dataLine = lines.find((line) => line.startsWith('data:'));
            if (!dataLine) {
              boundary = buffer.indexOf('\n\n');
              continue;
            }
            const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
            let payload = null;
            try {
              payload = JSON.parse(dataLine.slice(5).trim());
            } catch {
              payload = null;
            }
            events.push({ event: eventName, payload });
            if (eventName === 'done' || eventName === 'error') {
              request.destroy();
              resolve({
                statusCode: response.statusCode || 0,
                events,
              });
              return;
            }
            boundary = buffer.indexOf('\n\n');
          }
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            events,
          });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(Number(options.timeoutMs || 8000), () => {
      request.destroy(new Error('request timeout'));
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function writeJson(targetPath, payload) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('dashboard endpoints expose runs, details, metrics, and chat sessions', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-status-'));
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const logsRoot = path.join(runtimeRoot, 'logs');
  const requestsRoot = path.join(logsRoot, 'requests');
  const failedRoot = path.join(logsRoot, 'failed');
  const abandonedRoot = path.join(logsRoot, 'abandoned');
  const repoSearchFailedRoot = path.join(logsRoot, 'repo_search', 'failed');
  const repoSearchPassRoot = path.join(logsRoot, 'repo_search', 'succesful');
  fs.mkdirSync(repoSearchPassRoot, { recursive: true });

  writeJson(path.join(requestsRoot, 'request_req-summary.json'), {
    requestId: 'req-summary',
    question: 'Summarize build output',
    backend: 'llama.cpp',
    model: 'Qwen3.5-9B-Q8_0.gguf',
    summary: 'Build was successful.',
    createdAtUtc: '2026-04-01T10:00:00.000Z',
    inputTokens: 123,
    outputTokens: 45,
    thinkingTokens: 9,
    promptCacheTokens: 80,
    promptEvalTokens: 40,
    requestDurationMs: 3000,
  });
  writeJson(path.join(logsRoot, 'planner_debug_req-summary.json'), {
    final: {
      finalOutput: 'Build was successful.',
      classification: 'summary',
      rawReviewRequired: false,
      providerError: null,
    },
  });
  writeJson(path.join(failedRoot, 'request_failed_req-failed.json'), {
    requestId: 'req-failed',
    question: 'Analyze flaky test failure',
    error: 'timeout',
    createdAtUtc: '2026-04-01T10:05:00.000Z',
    inputTokens: 50,
    outputTokens: 0,
    thinkingTokens: 0,
    promptCacheTokens: 0,
    promptEvalTokens: 20,
    requestDurationMs: 1000,
  });
  writeJson(path.join(abandonedRoot, 'request_abandoned_req-abandoned.json'), {
    requestId: 'req-abandoned',
    terminalState: 'failed',
    reason: 'Abandoned because a new request started before terminal status.',
    createdAtUtc: '2026-04-01T10:10:00.000Z',
    promptCharacterCount: 1200,
    outputTokensTotal: 12,
  });
  writeJson(path.join(repoSearchFailedRoot, 'request_req-repo.json'), {
    requestId: 'req-repo',
    prompt: 'find failing test',
    repoRoot: tempRoot,
    verdict: 'fail',
    totals: { commandsExecuted: 1 },
    createdAtUtc: '2026-04-01T10:15:00.000Z',
  });
  fs.writeFileSync(
    path.join(repoSearchFailedRoot, 'request_req-repo.jsonl'),
    [
      JSON.stringify({ at: '2026-04-01T10:15:01.000Z', kind: 'turn_prompt', prompt: 'find failing test' }),
      JSON.stringify({ at: '2026-04-01T10:15:02.000Z', kind: 'turn_model_response', text: '{"action":"finish"}', thinkingText: 'reasoning' }),
      JSON.stringify({ at: '2026-04-01T10:15:03.000Z', kind: 'run_done', scorecard: { verdict: 'fail' } }),
    ].join('\n') + '\n',
    'utf8'
  );

  const envBackup = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await requestJson(`${baseUrl}/status`);
    assert.equal(health.statusCode, 200);

    const runsResponse = await requestJson(`${baseUrl}/dashboard/runs`);
    assert.equal(runsResponse.statusCode, 200);
    assert.equal(Array.isArray(runsResponse.body.runs), true);
    assert.ok(runsResponse.body.runs.length >= 4);
    const runKinds = new Set(runsResponse.body.runs.map((run) => run.kind));
    assert.equal(runKinds.has('summary_request'), true);
    assert.equal(runKinds.has('failed_request'), true);
    assert.equal(runKinds.has('request_abandoned'), true);
    assert.equal(runKinds.has('repo_search'), true);
    const repoRun = runsResponse.body.runs.find((run) => run.id === 'req-repo');
    assert.equal(Number(repoRun?.durationMs), 2000);

    const detailResponse = await requestJson(`${baseUrl}/dashboard/runs/req-repo`);
    assert.equal(detailResponse.statusCode, 200);
    assert.equal(detailResponse.body.run.id, 'req-repo');
    assert.equal(Array.isArray(detailResponse.body.events), true);
    assert.equal(detailResponse.body.events.some((event) => event.kind === 'turn_model_response'), true);

    const metricsResponse = await requestJson(`${baseUrl}/dashboard/metrics/timeseries`);
    assert.equal(metricsResponse.statusCode, 200);
    assert.equal(Array.isArray(metricsResponse.body.days), true);
    assert.equal(metricsResponse.body.days.length > 0, true);
    assert.equal(metricsResponse.body.days[0].runs >= 1, true);
    assert.equal(Number.isFinite(metricsResponse.body.days[0].promptCacheTokens), true);
    assert.equal(Number.isFinite(metricsResponse.body.days[0].promptEvalTokens), true);
    assert.equal(Number.isFinite(metricsResponse.body.days[0].cacheHitRate), true);
    assert.equal(metricsResponse.body.days[0].promptCacheTokens, 80);
    assert.equal(metricsResponse.body.days[0].promptEvalTokens, 60);
    assert.equal(Math.round(metricsResponse.body.days[0].cacheHitRate * 1000) / 1000, 0.571);

    const idleSummaryResponse = await requestJson(`${baseUrl}/dashboard/metrics/idle-summary`);
    assert.equal(idleSummaryResponse.statusCode, 200);
    assert.equal(Array.isArray(idleSummaryResponse.body.snapshots), true);
    assert.equal(Object.prototype.hasOwnProperty.call(idleSummaryResponse.body, 'latest'), true);

    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Session A',
        model: 'Qwen3.5-9B-Q8_0.gguf',
        contextWindowTokens: 10000,
      }),
    });
    assert.equal(createSession.statusCode, 200);
    assert.equal(typeof createSession.body.session.id, 'string');
    assert.equal(createSession.body.session.contextWindowTokens, 150000);
    assert.equal(createSession.body.session.mode, 'chat');
    assert.equal(createSession.body.session.planRepoRoot, process.cwd());
    const sessionId = createSession.body.session.id;

    const appendMessage = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'a'.repeat(26000),
        assistantContent: 'stored assistant response',
      }),
    });
    assert.equal(appendMessage.statusCode, 200);
    assert.equal(Array.isArray(appendMessage.body.session.messages), true);
    assert.equal(appendMessage.body.session.messages.length, 2);
    assert.equal(appendMessage.body.contextUsage.warnThresholdTokens, 15000);
    assert.equal(appendMessage.body.contextUsage.shouldCondense, false);

    const updateSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({
        mode: 'plan',
        planRepoRoot: tempRoot,
      }),
    });
    assert.equal(updateSession.statusCode, 200);
    assert.equal(updateSession.body.session.mode, 'plan');
    assert.equal(updateSession.body.session.planRepoRoot, tempRoot);

    const planMessage = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        content: 'Add a mode toggle to the dashboard chat panel.',
        repoRoot: tempRoot,
        maxTurns: 2,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"dashboard\\" ."}}',
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"/dashboard/chat/sessions\\" siftKitStatus/index.js"}}',
          '{"action":"finish","output":"Plan: update dashboard/src/App.tsx and siftKitStatus/index.js; include a risks section for endpoint lock contention and stale repo-root paths.","confidence":0.92}',
        ],
        mockCommandResults: {
          'rg -n "dashboard" .': { exitCode: 0, stdout: 'dashboard/src/App.tsx:1:import { useEffect }', stderr: '' },
          'rg -n "/dashboard/chat/sessions" siftKitStatus/index.js': { exitCode: 0, stdout: 'siftKitStatus/index.js:3068:    if (req.method === \'POST\' && pathname === \'/dashboard/chat/sessions\') {', stderr: '' },
        },
      }),
    });
    assert.equal(planMessage.statusCode, 200);
    assert.equal(planMessage.body.session.messages.length >= 4, true);
    assert.equal(Array.isArray(planMessage.body.session.hiddenToolContexts), true);
    assert.equal(planMessage.body.session.hiddenToolContexts.length >= 1, true);
    assert.equal(planMessage.body.contextUsage.totalUsedTokens > planMessage.body.contextUsage.chatUsedTokens, true);
    const latestMessage = planMessage.body.session.messages[planMessage.body.session.messages.length - 1];
    assert.equal(latestMessage.role, 'assistant');
    assert.equal(Number(latestMessage.associatedToolTokens || 0) > 0, true);
    assert.equal(
      Number(latestMessage.inputTokensEstimate || 0),
      Number(planMessage.body.repoSearch.scorecard?.totals?.promptTokens || 0)
    );
    assert.match(latestMessage.content, /^# Implementation Plan/mu);
    assert.match(latestMessage.content, /Critical Review/mu);
    assert.match(latestMessage.content, /## Artifacts/mu);
    const plannerCommands = Array.from(
      latestMessage.content.matchAll(/^- Command: `([^`]+)`$/gmu),
      (match) => match[1]
    );
    const newestCommandIndex = plannerCommands.findIndex((command) => command.includes('/dashboard/chat/sessions'));
    const oldestCommandIndex = plannerCommands.findIndex((command) => command.includes('dashboard'));
    assert.equal(newestCommandIndex >= 0, true);
    assert.equal(oldestCommandIndex >= 0, true);
    const plannerArtifact = JSON.parse(fs.readFileSync(planMessage.body.repoSearch.artifactPath, 'utf8'));
    assert.equal(plannerArtifact.requestMaxTokens, 10000);
    assert.match(plannerArtifact.prompt, /Start with a short "Summary of Request and Approach"/u);
    assert.match(plannerArtifact.prompt, /Open Questions \(if any\)/u);
    assert.match(plannerArtifact.prompt, /misalignment between the request and existing repository behavior/u);

    const clearToolContextResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/tool-context/clear`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(clearToolContextResponse.statusCode, 200);
    assert.equal(Array.isArray(clearToolContextResponse.body.session.hiddenToolContexts), true);
    assert.equal(clearToolContextResponse.body.session.hiddenToolContexts.length, 0);
    assert.equal(clearToolContextResponse.body.contextUsage.toolUsedTokens, 0);
    assert.equal(clearToolContextResponse.body.contextUsage.totalUsedTokens, clearToolContextResponse.body.contextUsage.chatUsedTokens);

    const condenseResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/condense`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(condenseResponse.statusCode, 200);
    assert.equal(typeof condenseResponse.body.session.condensedSummary, 'string');
    assert.match(condenseResponse.body.session.condensedSummary, /stored assistant response/u);

    const sessionsResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`);
    assert.equal(sessionsResponse.statusCode, 200);
    assert.equal(sessionsResponse.body.sessions.length, 1);

    const sessionDetail = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(sessionDetail.statusCode, 200);
    assert.equal(sessionDetail.body.session.id, sessionId);

    const deleteSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteSession.statusCode, 200);
    assert.equal(deleteSession.body.deleted, true);

    const sessionsAfterDelete = await requestJson(`${baseUrl}/dashboard/chat/sessions`);
    assert.equal(sessionsAfterDelete.statusCode, 200);
    assert.equal(sessionsAfterDelete.body.sessions.length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('plan/repo-search stream events include backend promptTokenCount', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-stream-tokens-'));
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Stream Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = createSession.body.session.id;

    const planSse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan/stream`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        content: 'Add API tests',
        repoRoot: tempRoot,
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"test\\" ."}}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "test" .': { exitCode: 0, stdout: 'tests/example.test.ts:1:test()', stderr: '' },
        },
      }),
    });
    assert.equal(planSse.statusCode, 200);
    const planToolStart = planSse.events.find((event) => event.event === 'tool_start');
    const planToolResult = planSse.events.find((event) => event.event === 'tool_result');
    assert.equal(Number.isFinite(Number(planToolStart?.payload?.promptTokenCount)), true);
    assert.equal(Number.isFinite(Number(planToolResult?.payload?.promptTokenCount)), true);

    const repoSse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/stream`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        content: 'Find tests',
        repoRoot: tempRoot,
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"test\\" ."}}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "test" .': { exitCode: 0, stdout: 'tests/example.test.ts:1:test()', stderr: '' },
        },
      }),
    });
    assert.equal(repoSse.statusCode, 200);
    const repoToolStart = repoSse.events.find((event) => event.event === 'tool_start');
    const repoToolResult = repoSse.events.find((event) => event.event === 'tool_result');
    assert.equal(Number.isFinite(Number(repoToolStart?.payload?.promptTokenCount)), true);
    assert.equal(Number.isFinite(Number(repoToolResult?.payload?.promptTokenCount)), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('package start script launches the dedicated dual-server start runner', () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.equal(typeof packageJson.scripts?.start, 'string');
  assert.match(packageJson.scripts.start, /scripts[\\/]+start-dev\.js/u);
});

test('repo-search and dashboard chat messages serialize by waiting', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-lock-'));
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Locked session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
        contextWindowTokens: 10000,
      }),
    });
    const sessionId = createSession.body.session.id;

    const delayedRepoSearch = requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        simulateWorkMs: 1200,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"x\\" src"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 2000 },
        },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const blockedChatStart = Date.now();
    const blockedChat = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        content: 'should wait while repo-search is running',
        assistantContent: 'stored assistant response',
      }),
    });
    const blockedChatElapsedMs = Date.now() - blockedChatStart;
    assert.equal(blockedChat.statusCode, 200);
    assert.equal(blockedChatElapsedMs >= 1000, true);

    await delayedRepoSearch;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('plan endpoint rejects missing or invalid repo root', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-plan-root-'));
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Plan Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = createSession.body.session.id;
    const missingRootResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'create plan',
        repoRoot: path.join(tempRoot, 'missing'),
      }),
    });
    assert.equal(missingRootResponse.statusCode, 400);
    assert.match(String(missingRootResponse.body.error || ''), /Expected existing repoRoot directory/u);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('chat completion receives hidden tool context while keeping it out of visible chat history', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-toolctx-'));
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  let capturedChatRequest = null;
  const llamaServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      capturedChatRequest = JSON.parse(raw);
      const responseBody = {
        choices: [
          {
            message: {
              content: 'ack',
              reasoning_content: '',
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 4,
          completion_tokens_details: {
            reasoning_tokens: 0,
          },
        },
      };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise((resolve, reject) => llamaServer.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve())));
  const llamaAddress = llamaServer.address();
  writeJson(configPath, {
    Runtime: {
      Model: 'Qwen3.5-9B-Q8_0.gguf',
      LlamaCpp: {
        BaseUrl: `http://127.0.0.1:${llamaAddress.port}`,
        NumCtx: 85000,
      },
    },
  });

  const envBackup = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Tool Context Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = createSession.body.session.id;
    const planMessage = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        content: 'audit release gaps',
        repoRoot: tempRoot,
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"name\\" package.json"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "name" package.json': { exitCode: 0, stdout: 'package.json:2:  "name": "siftkit"', stderr: '' },
        },
      }),
    });
    assert.equal(planMessage.statusCode, 200);
    assert.equal(planMessage.body.session.hiddenToolContexts.length >= 1, true);

    const chatReply = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        content: 'use prior evidence and summarize next steps',
      }),
    });
    assert.equal(chatReply.statusCode, 200);
    assert.equal(capturedChatRequest !== null, true);
    assert.equal(Array.isArray(capturedChatRequest.messages), true);
    const systemMessages = capturedChatRequest.messages.filter((message) => message && message.role === 'system');
    const hiddenToolSystemMessage = systemMessages.find((message) => String(message.content || '').includes('Internal tool-call context from prior session steps.'));
    assert.equal(Boolean(hiddenToolSystemMessage), true);
    assert.match(String(hiddenToolSystemMessage.content || ''), /Command: rg -n "name" package\.json/u);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => llamaServer.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
