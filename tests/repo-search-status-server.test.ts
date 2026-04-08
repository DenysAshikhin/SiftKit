import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { startStatusServer, buildRepoSearchProgressLogMessage } from '../dist/status-server/index.js';

const requireFromHere = createRequire(__filename);

type JsonResponse = { statusCode: number; body: Record<string, unknown> };
type RequestOptions = { method?: string; body?: string; timeoutMs?: number };

function requestJson(url: string, options: RequestOptions = {}): Promise<JsonResponse> {
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
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: responseText ? JSON.parse(responseText) as Record<string, unknown> : {},
          });
        });
      },
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

test('status server stays responsive while repo-search is running', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-status-'));
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const baselineStatus = await requestJson(`${baseUrl}/status`);
    const baselineMetrics = (baselineStatus.body?.metrics as Record<string, unknown>) || {};
    const baselineCompleted = Number(baselineMetrics.completedRequestCount || 0);
    const baselineInputChars = Number(baselineMetrics.inputCharactersTotal || 0);
    const baselineDurationMs = Number(baselineMetrics.requestDurationMsTotal || 0);

    const delayedRequest = requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"x\\" src"}}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 2000 },
        },
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const healthStart = Date.now();
    const healthResponse = await requestJson(`${baseUrl}/health`);
    const healthLatencyMs = Date.now() - healthStart;

    assert.equal(healthResponse.statusCode, 200);
    assert.equal(healthResponse.body.ok, true);
    assert.ok(healthLatencyMs < 800, `expected fast /health while repo-search runs, got ${healthLatencyMs}ms`);

    const searchResponse = await delayedRequest;
    assert.ok(searchResponse.statusCode >= 200 && searchResponse.statusCode < 600);
    assert.equal(typeof searchResponse.body, 'object');

    const finalStatus = await requestJson(`${baseUrl}/status`);
    const finalMetrics = (finalStatus.body?.metrics as Record<string, unknown>) || {};
    if (searchResponse.statusCode >= 200 && searchResponse.statusCode < 300) {
      assert.ok(Number(finalMetrics.completedRequestCount || 0) >= baselineCompleted + 1);
    } else {
      assert.ok(Number(finalMetrics.completedRequestCount || 0) >= baselineCompleted);
    }
    assert.ok(Number(finalMetrics.inputCharactersTotal || 0) >= baselineInputChars + 'find x'.length);
    assert.ok(Number(finalMetrics.requestDurationMsTotal || 0) > baselineDurationMs);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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

test('buildRepoSearchProgressLogMessage formats planner and repo-search command progress lines', () => {
  const msg1 = buildRepoSearchProgressLogMessage({
    turn: 2,
    maxTurns: 9,
    promptTokenCount: 1234,
    elapsedMs: 2500,
    command: 'rg -n "planner" src',
  }, 'repo_search');
  assert.ok(msg1);
  assert.match(msg1, /^repo_search command turn=2\/9 prompt_tokens=1,234 elapsed=2s command=rg -n "planner" src$/u);
  const msg2 = buildRepoSearchProgressLogMessage({
    turn: 1,
    maxTurns: 2,
    promptTokenCount: 88,
    elapsedMs: 0,
    command: 'rg -n "dashboard" .',
  }, 'planner');
  assert.ok(msg2);
  assert.match(msg2, /^planner command turn=1\/2 prompt_tokens=88 elapsed=0s command=rg -n "dashboard" \.$/u);
  const msg3 = buildRepoSearchProgressLogMessage({
    kind: 'llm_start',
    turn: 18,
    maxTurns: 45,
    promptTokenCount: 312345,
    elapsedMs: 4200,
  }, 'repo_search');
  assert.ok(msg3);
  assert.match(msg3, /^repo_search llm_start turn=18\/45 prompt_tokens=312,345 elapsed=4s$/u);
  const msg4 = buildRepoSearchProgressLogMessage({
    kind: 'llm_end',
    turn: 18,
    maxTurns: 45,
    promptTokenCount: 312345,
    elapsedMs: 7800,
  }, 'repo_search');
  assert.ok(msg4);
  assert.match(msg4, /^repo_search llm_end turn=18\/45 prompt_tokens=312,345 elapsed=7s$/u);
});

test('repo-search endpoint reloads executor module per request', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-reload-'));
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const repoSearchModulePath = requireFromHere.resolve('../dist/repo-search/index.js');
  const priorCacheEntry = requireFromHere.cache[repoSearchModulePath];

  try {
    requireFromHere.cache[repoSearchModulePath] = {
      id: repoSearchModulePath,
      filename: repoSearchModulePath,
      loaded: true,
      exports: {
        executeRepoSearchRequest: async () => ({
          requestId: 'cache-hit',
          transcriptPath: '',
          artifactPath: '',
          scorecard: {
            runId: 'cache-hit',
            model: 'cache-hit',
            tasks: [{
              id: 'repo-search',
              question: 'cache-hit',
              reason: 'finish',
              turnsUsed: 0,
              safetyRejects: 0,
              invalidResponses: 0,
              commandFailures: 0,
              commands: [],
              finalOutput: 'CACHE_HIT_OUTPUT',
              passed: true,
              missingSignals: [],
            }],
            totals: {
              tasks: 1,
              passed: 1,
              failed: 0,
              commandsExecuted: 0,
              safetyRejects: 0,
              invalidResponses: 0,
              commandFailures: 0,
            },
            verdict: 'pass',
            failureReasons: [],
          },
        }),
      },
    } as unknown as NodeJS.Require['cache'][string];

    const response = await requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"rg -n \\"x\\" src"}}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '' },
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const scorecard = response.body?.scorecard as { tasks?: Array<{ finalOutput?: string }> } | undefined;
    const finalOutput = String(scorecard?.tasks?.[0]?.finalOutput || '');
    assert.notEqual(finalOutput, 'CACHE_HIT_OUTPUT');
  } finally {
    if (priorCacheEntry) {
      requireFromHere.cache[repoSearchModulePath] = priorCacheEntry;
    } else {
      delete requireFromHere.cache[repoSearchModulePath];
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
