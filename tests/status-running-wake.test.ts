import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { getDefaultMetrics } from '../dist/status-server/metrics.js';
import { createRequestHandler } from '../dist/status-server/routes.js';
import type { ServerContext } from '../dist/status-server/server-types.js';

type JsonResponse = { statusCode: number; body: Record<string, unknown> };

function requestJson(url: string, body: Record<string, unknown>): Promise<JsonResponse> {
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
            body: responseText ? JSON.parse(responseText) as Record<string, unknown> : {},
          });
        });
      },
    );
    request.on('error', reject);
    request.write(bodyText);
    request.end();
  });
}

function createStatusContext(tempRoot: string): ServerContext & { readonly wakeCount: number } {
  let wakeCount = 0;
  return {
    configPath: path.join(tempRoot, 'config.json'),
    statusPath: path.join(tempRoot, 'status.txt'),
    metricsPath: path.join(tempRoot, 'metrics.json'),
    idleSummarySnapshotsPath: path.join(tempRoot, 'idle.sqlite'),
    disableManagedLlamaStartup: false,
    server: null,
    getServiceBaseUrl(): string {
      return 'http://127.0.0.1:0';
    },
    metrics: getDefaultMetrics(),
    activeRunsByRequestId: new Map(),
    activeRequestIdByStatusPath: new Map(),
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
    async shutdownManagedLlamaIfNeeded(): Promise<void> {},
    async ensureManagedLlamaReady(): Promise<Record<string, never>> {
      wakeCount += 1;
      return {};
    },
    get wakeCount(): number {
      return wakeCount;
    },
  } as ServerContext & { readonly wakeCount: number };
}

test('running status notifications wake managed llama for direct provider requests', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-status-wake-'));
  const ctx = createStatusContext(tempRoot);
  fs.writeFileSync(ctx.configPath, '{}', 'utf8');

  const server = http.createServer(createRequestHandler(ctx));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
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
