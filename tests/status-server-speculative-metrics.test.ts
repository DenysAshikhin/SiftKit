const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { writeConfig } = require('../dist/status-server/config-store.js');
const {
  flushRunArtifactsToDbAndDelete,
  queryDashboardRunDetailFromDb,
  queryDashboardRunsFromDb,
  upsertRepoSearchRun,
} = require('../dist/status-server/dashboard-runs.js');
const {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaSpeculativeMetricsDelta,
} = require('../dist/status-server/managed-llama.js');
const {
  bufferManagedLlamaLogChunk,
  readManagedLlamaLogTextByStream,
} = require('../dist/state/managed-llama-runs.js');

const {
  getDefaultConfig,
  setManagedLlamaBaseUrl,
  requestJson,
  withTempEnv,
  withRealStatusServer,
  writeManagedLlamaLauncher,
  getFreePort,
  waitForAsyncExpectation,
} = require('./_runtime-helpers.js');

test('managed llama speculative delta prefers cumulative token stats over rate lines in the same slice', async () => {
  await withTempEnv(async () => {
    const runId = 'repo-run-speculative-same-slice';
    const logRef = {
      runId,
      purpose: 'startup',
      scriptPath: 'mock-llama.exe',
      baseUrl: 'http://127.0.0.1:8097',
    };
    bufferManagedLlamaLogChunk({
      runId,
      streamKind: 'startup_script_stdout',
      chunkText: 'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837\n',
    });
    const snapshot = captureManagedLlamaSpeculativeMetricsSnapshot(logRef);
    assert.equal(snapshot?.latestSpeculativeAcceptedTokens, 5837);
    assert.equal(snapshot?.latestSpeculativeGeneratedTokens, 6168);

    bufferManagedLlamaLogChunk({
      runId,
      streamKind: 'startup_script_stderr',
      chunkText: [
        'draft acceptance rate = 1.00000 (    4 accepted /     4 generated)',
        'statistics ngram_mod: #calls(b,g,a) = 21 3028 132, #gen drafts = 132, #acc drafts = 132, #gen tokens = 6200, #acc tokens = 5841',
      ].join('\n') + '\n',
    });

    const delta = getManagedLlamaSpeculativeMetricsDelta(logRef, snapshot);
    assert.equal(delta?.speculativeAcceptedTokens, 4);
    assert.equal(delta?.speculativeGeneratedTokens, 32);
  });
});

test('real status server uses managed llama cumulative speculative delta for repo-search run logs', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'repo-run-speculative-cumulative';
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaLauncher(tempRoot, llamaPort, 'managed-test-model', {
      startupLogLine: 'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = config.Server || {};
    config.Server.LlamaCpp = {
      ...(config.Server.LlamaCpp || {}),
      BaseUrl: managed.baseUrl,
      BindHost: '127.0.0.1',
      Port: llamaPort,
      ExecutablePath: managed.executablePath,
      ModelPath: managed.modelPath,
      StartupTimeoutMs: 5000,
      HealthcheckTimeoutMs: 200,
      HealthcheckIntervalMs: 50,
    };
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      const database = new Database(runtimeDbPath);
      let startupRunId = '';
      let managedLlamaSnapshot = null;
      try {
        const startupRun = database.prepare(`
          SELECT id
          FROM managed_llama_runs
          ORDER BY started_at_utc DESC, id DESC
          LIMIT 1
        `).get();
        startupRunId = String(startupRun?.id || '');
        assert.ok(startupRunId);
        await waitForAsyncExpectation(async () => {
          const startupLogs = readManagedLlamaLogTextByStream(startupRunId);
          assert.match(String(startupLogs.startup_script_stdout || ''), /#gen tokens = 6168/u);
        }, 5000);
        managedLlamaSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot({
          runId: startupRunId,
          purpose: 'startup',
          scriptPath: managed.executablePath,
          baseUrl: managed.baseUrl,
        });
        assert.equal(managedLlamaSnapshot?.latestSpeculativeAcceptedTokens, 5837);
        assert.equal(managedLlamaSnapshot?.latestSpeculativeGeneratedTokens, 6168);
        upsertRepoSearchRun({
          database,
          requestId,
          taskKind: 'repo-search',
          prompt: 'find speculative metrics',
          repoRoot: tempRoot,
          model: 'mock-model',
          requestMaxTokens: 512,
          maxTurns: 2,
          transcriptText: '',
          artifactPayload: { requestId, prompt: 'find speculative metrics', repoRoot: tempRoot },
          terminalState: 'completed',
          startedAtUtc: '2026-04-20T11:49:38.706Z',
          finishedAtUtc: '2026-04-20T11:50:26.779Z',
          requestDurationMs: 48073,
          promptTokens: 10,
          outputTokens: 5,
          thinkingTokens: 2,
          toolTokens: 1,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
          speculativeAcceptedTokens: null,
          speculativeGeneratedTokens: null,
        });
      } finally {
        database.close();
      }

      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId,
          taskKind: 'repo-search',
          rawInputCharacterCount: 24,
          promptCharacterCount: 24,
        }),
      });

      bufferManagedLlamaLogChunk({
        runId: startupRunId,
        streamKind: 'startup_script_stderr',
        chunkText: [
          'draft acceptance rate = 1.00000 (   47 accepted /    47 generated)',
          'draft acceptance rate = 1.00000 (   11 accepted /    11 generated)',
          'statistics ngram_mod: #calls(b,g,a) = 26 5746 137, #gen drafts = 137, #acc drafts = 137, #gen tokens = 6426, #acc tokens = 5895',
        ].join('\n') + '\n',
      });
      const managedLlamaDelta = getManagedLlamaSpeculativeMetricsDelta({
        runId: startupRunId,
        purpose: 'startup',
        scriptPath: managed.executablePath,
        baseUrl: managed.baseUrl,
      }, managedLlamaSnapshot);
      assert.equal(managedLlamaDelta?.speculativeAcceptedTokens, 58);
      assert.equal(managedLlamaDelta?.speculativeGeneratedTokens, 258);

      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          requestId,
          taskKind: 'repo-search',
          terminalState: 'completed',
          promptCharacterCount: 24,
          inputTokens: 7,
          outputCharacterCount: 12,
          outputTokens: 5,
          thinkingTokens: 2,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
          speculativeAcceptedTokens: 47,
          speculativeGeneratedTokens: 47,
          requestDurationMs: 48073,
        }),
      });

      const verifyDb = new Database(runtimeDbPath, { readonly: true });
      try {
        const row = verifyDb.prepare(`
          SELECT speculative_accepted_tokens, speculative_generated_tokens
          FROM run_logs
          WHERE request_id = ?
        `).get(requestId);
        assert.equal(row.speculative_accepted_tokens, 58);
        assert.equal(row.speculative_generated_tokens, 258);
      } finally {
        verifyDb.close();
      }
    }, {
      statusPath,
      configPath: runtimeDbPath,
    });
  });
});

test('dashboard runs keep persisted speculative totals when artifact payloads disagree', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeRoot = path.join(tempRoot, '.siftkit');
    const runtimeDbPath = path.join(runtimeRoot, 'runtime.sqlite');
    const logsRoot = path.join(runtimeRoot, 'logs');
    const requestsRoot = path.join(logsRoot, 'requests');
    const repoSearchPassRoot = path.join(logsRoot, 'repo_search', 'succesful');
    const requestId = 'repo-run-persisted-canonical-speculative';

    fs.mkdirSync(requestsRoot, { recursive: true });
    fs.mkdirSync(repoSearchPassRoot, { recursive: true });

    const database = new Database(runtimeDbPath);
    try {
      upsertRepoSearchRun({
        database,
        requestId,
        taskKind: 'repo-search',
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        model: 'mock-model',
        requestMaxTokens: 512,
        maxTurns: 2,
        transcriptText: '',
        artifactPayload: { requestId, prompt: 'find speculative metrics', repoRoot: tempRoot },
        terminalState: 'completed',
        startedAtUtc: '2026-04-20T11:49:38.706Z',
        finishedAtUtc: '2026-04-20T11:50:26.779Z',
        requestDurationMs: 48073,
        promptTokens: 10,
        outputTokens: 5,
        thinkingTokens: 2,
        toolTokens: 1,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
        speculativeAcceptedTokens: 58,
        speculativeGeneratedTokens: 258,
      });

      fs.writeFileSync(path.join(requestsRoot, `request_${requestId}.json`), JSON.stringify({
        requestId,
        question: 'find speculative metrics',
        createdAtUtc: '2026-04-20T11:49:38.706Z',
        speculativeAcceptedTokens: 47,
        speculativeGeneratedTokens: 47,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
      }, null, 2));
      fs.writeFileSync(path.join(repoSearchPassRoot, `request_${requestId}.json`), JSON.stringify({
        requestId,
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        createdAtUtc: '2026-04-20T11:49:38.706Z',
        totals: {
          promptTokens: 10,
          outputTokens: 5,
          thinkingTokens: 2,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
          speculativeAcceptedTokens: 11,
          speculativeGeneratedTokens: 11,
        },
      }, null, 2));

      const flushed = flushRunArtifactsToDbAndDelete({
        database,
        requestId,
        terminalState: 'completed',
        taskKind: 'repo-search',
      });
      assert.equal(flushed, true);
    } finally {
      database.close();
    }

    const verifyDb = new Database(runtimeDbPath);
    try {
      const runs = queryDashboardRunsFromDb(verifyDb);
      const run = runs.find((entry) => entry.id === requestId);
      assert.equal(run?.speculativeAcceptedTokens, 58);
      assert.equal(run?.speculativeGeneratedTokens, 258);

      const detail = queryDashboardRunDetailFromDb(verifyDb, requestId);
      assert.equal(detail?.run.speculativeAcceptedTokens, 58);
      assert.equal(detail?.run.speculativeGeneratedTokens, 258);
    } finally {
      verifyDb.close();
    }
  });
});

test('dashboard runs keep speculative totals null when only artifact payloads provide them', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeRoot = path.join(tempRoot, '.siftkit');
    const runtimeDbPath = path.join(runtimeRoot, 'runtime.sqlite');
    const logsRoot = path.join(runtimeRoot, 'logs');
    const requestsRoot = path.join(logsRoot, 'requests');
    const repoSearchPassRoot = path.join(logsRoot, 'repo_search', 'succesful');
    const requestId = 'repo-run-artifact-only-speculative';

    fs.mkdirSync(requestsRoot, { recursive: true });
    fs.mkdirSync(repoSearchPassRoot, { recursive: true });

    const database = new Database(runtimeDbPath);
    try {
      upsertRepoSearchRun({
        database,
        requestId,
        taskKind: 'repo-search',
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        model: 'mock-model',
        requestMaxTokens: 512,
        maxTurns: 2,
        transcriptText: '',
        artifactPayload: { requestId, prompt: 'find speculative metrics', repoRoot: tempRoot },
        terminalState: 'completed',
        startedAtUtc: '2026-04-22T17:00:00.000Z',
        finishedAtUtc: '2026-04-22T17:00:30.000Z',
        requestDurationMs: 30000,
        promptTokens: 10,
        outputTokens: 5,
        thinkingTokens: 2,
        toolTokens: 1,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
        speculativeAcceptedTokens: null,
        speculativeGeneratedTokens: null,
      });

      fs.writeFileSync(path.join(requestsRoot, `request_${requestId}.json`), JSON.stringify({
        requestId,
        question: 'find speculative metrics',
        createdAtUtc: '2026-04-22T17:00:00.000Z',
        speculativeAcceptedTokens: 47,
        speculativeGeneratedTokens: 47,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
      }, null, 2));
      fs.writeFileSync(path.join(repoSearchPassRoot, `request_${requestId}.json`), JSON.stringify({
        requestId,
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        createdAtUtc: '2026-04-22T17:00:00.000Z',
        totals: {
          promptTokens: 10,
          outputTokens: 5,
          thinkingTokens: 2,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
          speculativeAcceptedTokens: 11,
          speculativeGeneratedTokens: 11,
        },
      }, null, 2));

      const flushed = flushRunArtifactsToDbAndDelete({
        database,
        requestId,
        terminalState: 'completed',
        taskKind: 'repo-search',
      });
      assert.equal(flushed, true);
    } finally {
      database.close();
    }

    const verifyDb = new Database(runtimeDbPath);
    try {
      const runs = queryDashboardRunsFromDb(verifyDb);
      const run = runs.find((entry) => entry.id === requestId);
      assert.equal(run?.speculativeAcceptedTokens, null);
      assert.equal(run?.speculativeGeneratedTokens, null);

      const detail = queryDashboardRunDetailFromDb(verifyDb, requestId);
      assert.equal(detail?.run.speculativeAcceptedTokens, null);
      assert.equal(detail?.run.speculativeGeneratedTokens, null);
    } finally {
      verifyDb.close();
    }
  });
});
