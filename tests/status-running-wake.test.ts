import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from '../src/lib/zod.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { getDefaultMetrics } from '../src/status-server/metrics.js';
import { getDefaultConfig } from '../src/status-server/config-store.js';
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import { createRequestHandler } from '../src/status-server/routes.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';

type JsonResponse = { statusCode: number; body: JsonObject };

function requestJson(url: string, body: JsonObject): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const bodyText = JSON.stringify(body);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText, 'utf8'),
        },
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
            body: responseText ? asObject(parseJsonValueText(responseText)) : {},
          });
        });
      },
    );
    request.on('error', reject);
    request.write(bodyText);
    request.end();
  });
}

const StatusContextSchema = z.custom<ServerContext & { readonly wakeCount: number }>(
  (value) => typeof value === 'object' && value !== null,
);

function createStatusContext(tempRoot: string): ServerContext & { readonly wakeCount: number } {
  let wakeCount = 0;
  return StatusContextSchema.parse({
    configPath: path.join(tempRoot, 'config.json'),
    statusPath: path.join(tempRoot, 'status.txt'),
    metricsPath: path.join(tempRoot, 'metrics.json'),
    idleSummarySnapshotsPath: path.join(tempRoot, 'idle.sqlite'),
    disableManagedLlamaStartup: false,
    engineService: new StatusEngineService(),
    terminalMetadataQueue: [],
    terminalMetadataDrainScheduled: false,
    terminalMetadataDrainRunning: false,
    terminalMetadataLastModelRequestFinishedAtMs: null,
    terminalMetadataIdleDelayMs: 0,
    runtimeHistoryPruneTimer: null,
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
    managedLlamaReady: false,
    managedLlamaStartupWarning: null,
    bootstrapManagedLlamaStartup: false,
    managedLlamaLogCleanupTimer: null,
    managedLlamaFlushQueue: new ManagedLlamaFlushQueue(),
    async shutdownManagedLlamaIfNeeded(): Promise<void> {},
    async ensureManagedLlamaReady() {
      wakeCount += 1;
      return getDefaultConfig();
    },
    get wakeCount(): number {
      return wakeCount;
    },
  });
}

test('running status notifications wake managed llama for direct provider requests', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-status-wake-'));
  const ctx = createStatusContext(tempRoot);
  fs.writeFileSync(ctx.configPath, '{}', 'utf8');

  const server = http.createServer(createRequestHandler(ctx));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = getAddressInfo(server);
  try {
    const response = await requestJson(`http://127.0.0.1:${address.port}/status`, {
      running: true,
      taskKind: 'summary',
      requestId: 'direct-summary',
      rawInputCharacterCount: 100,
      promptCharacterCount: 50,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.running, true);
    assert.equal(ctx.wakeCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
