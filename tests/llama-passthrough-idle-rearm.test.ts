import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { getDefaultMetrics } from '../dist/status-server/metrics.js';
import { ManagedLlamaFlushQueue } from '../dist/status-server/managed-llama-flush-queue.js';
import { handleLlamaPassthroughRoute } from '../dist/status-server/routes/llama-passthrough.js';
import { writeConfig } from '../dist/status-server/config-store.js';
import type { ServerContext } from '../dist/status-server/server-types.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

type TestHarness = {
  ctx: ServerContext;
  hostBaseUrl: string;
  cleanup: () => Promise<void>;
};

function createPassthroughHarness(tempRoot: string): Promise<TestHarness> {
  return new Promise((resolveHarness) => {
    const upstream = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
          }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    upstream.listen(0, '127.0.0.1', () => {
      const upstreamAddress = upstream.address() as AddressInfo;
      const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;

      const configPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      writeConfig(configPath, {
        Backend: 'llama.cpp',
        Model: 'test-model',
        Runtime: {
          Model: 'test-model',
          LlamaCpp: {
            BaseUrl: upstreamBaseUrl,
            ModelPath: path.join(tempRoot, 'fake-model.gguf'),
            NumCtx: 4096,
          },
        },
        Server: {
          LlamaCpp: {
            BaseUrl: upstreamBaseUrl,
            ExternalServerEnabled: true,
            HealthcheckTimeoutMs: 500,
            HealthcheckIntervalMs: 50,
          },
        },
      });

      const flushQueue = new ManagedLlamaFlushQueue();
      const ctx: ServerContext = {
        configPath,
        statusPath: path.join(tempRoot, 'status.txt'),
        metricsPath: path.join(tempRoot, 'metrics.sqlite'),
        idleSummarySnapshotsPath: path.join(tempRoot, 'idle.sqlite'),
        disableManagedLlamaStartup: true,
        server: null,
        getServiceBaseUrl(): string {
          return 'http://127.0.0.1:0';
        },
        metrics: getDefaultMetrics(),
        activeRunsByRequestId: new Map(),
        activeRequestIdByStatusPath: new Map(),
        completedRequestIdByStatusPath: new Map(),
        activeModelRequest: null,
        modelRequestQueue: [],
        activeExecutionLease: null,
        deferredArtifactQueue: [],
        deferredArtifactDrainScheduled: false,
        deferredArtifactDrainRunning: false,
        terminalMetadataQueue: [],
        terminalMetadataDrainScheduled: false,
        terminalMetadataDrainRunning: false,
        terminalMetadataLastModelRequestFinishedAtMs: null,
        terminalMetadataIdleDelayMs: 1_000,
        pendingIdleSummaryMetadata: {
          inputCharactersPerContextToken: null,
          chunkThresholdCharacters: null,
        },
        idleSummaryTimer: null,
        idleSummaryPending: false,
        idleSummaryDatabase: null,
        managedLlamaStartupPromise: null,
        managedLlamaShutdownPromise: null,
        managedLlamaHostProcess: null,
        managedLlamaLastStartupLogs: null,
        managedLlamaStarting: false,
        managedLlamaReady: true,
        managedLlamaStartupWarning: null,
        bootstrapManagedLlamaStartup: false,
        managedLlamaLogCleanupTimer: null,
        runtimeHistoryPruneTimer: null,
        managedLlamaFlushQueue: flushQueue,
        async shutdownManagedLlamaIfNeeded(): Promise<void> {},
        async ensureManagedLlamaReady(): Promise<Record<string, never>> {
          return {};
        },
      };

      const hostServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const handled = await handleLlamaPassthroughRoute(ctx, req, res, url.pathname);
        if (!handled && !res.headersSent) {
          res.writeHead(404).end();
        }
      });
      hostServer.listen(0, '127.0.0.1', () => {
        const hostAddress = hostServer.address() as AddressInfo;
        const hostBaseUrl = `http://127.0.0.1:${hostAddress.port}`;

        const cleanup = async (): Promise<void> => {
          if (ctx.idleSummaryTimer) {
            clearTimeout(ctx.idleSummaryTimer);
            ctx.idleSummaryTimer = null;
          }
          await new Promise<void>((resolve) => hostServer.close(() => resolve()));
          await new Promise<void>((resolve) => upstream.close(() => resolve()));
          await flushQueue.close();
        };

        resolveHarness({ ctx, hostBaseUrl, cleanup });
      });
    });
  });
}

function postChatCompletions(hostBaseUrl: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${hostBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ statusCode: response.statusCode || 0, body });
      });
    });
    request.on('error', reject);
    request.write(JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    request.end();
  });
}

function getModels(hostBaseUrl: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${hostBaseUrl}/v1/models`, { method: 'GET' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ statusCode: response.statusCode || 0, body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('passthrough chat completions arms the idle unload timer after release', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-passthrough-idle-chat-'));
  const harness = await createPassthroughHarness(tempRoot);
  try {
    assert.equal(harness.ctx.idleSummaryPending, false);
    assert.equal(harness.ctx.idleSummaryTimer, null);

    const response = await postChatCompletions(harness.hostBaseUrl);
    assert.equal(response.statusCode, 200, `expected 200 from chat passthrough, got ${response.statusCode}: ${response.body}`);

    assert.equal(harness.ctx.idleSummaryPending, true, 'idleSummaryPending must be true after chat passthrough');
    assert.notEqual(harness.ctx.idleSummaryTimer, null, 'idleSummaryTimer must be armed after chat passthrough');
  } finally {
    await harness.cleanup();
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('passthrough /v1/models arms the idle unload timer after release', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-passthrough-idle-models-'));
  const harness = await createPassthroughHarness(tempRoot);
  try {
    assert.equal(harness.ctx.idleSummaryPending, false);
    assert.equal(harness.ctx.idleSummaryTimer, null);

    const response = await getModels(harness.hostBaseUrl);
    assert.equal(response.statusCode, 200, `expected 200 from models passthrough, got ${response.statusCode}: ${response.body}`);

    assert.equal(harness.ctx.idleSummaryPending, true, 'idleSummaryPending must be true after models passthrough');
    assert.notEqual(harness.ctx.idleSummaryTimer, null, 'idleSummaryTimer must be armed after models passthrough');
  } finally {
    await harness.cleanup();
    closeRuntimeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
