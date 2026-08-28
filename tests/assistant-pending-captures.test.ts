import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PENDING_CAPTURE_LIST_STATES, PendingCaptureDtoSchema, PendingCapturesResponseSchema,
} from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function captureDto(pixelSeed: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    capturedAtUtc: new Date().toISOString(),
    reason: 'fixed_cadence',
    display: {
      id: 'DISPLAY1', name: 'Monitor', primary: true,
      pixelWidth: 1920, pixelHeight: 1080, logicalWidth: 1920, logicalHeight: 1080,
      scaleFactor: 1,
    },
    foregroundContextKey: 'app:code|siftkit',
    foreground: {
      processName: 'Code.exe',
      executablePath: 'C:/Code.exe',
      applicationId: 'app:code',
      normalizedTitle: 'SiftKit',
      fullscreen: false,
    },
    pixelSha256: pixelSeed.repeat(64).slice(0, 64),
    perceptualHash: 'f'.repeat(16),
    imageDataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  };
}

test('pending captures route lists queued captures whose pixels the evidence route serves', async () => {
  const tempRoot = createManagedTempDir('siftkit-pending-captures-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  writeConfig(getConfigPath(), {
    ...initial,
    Assistant: {
      ...initial.Assistant,
      Enabled: true,
      Observation: { ...initial.Assistant.Observation, ScreenshotsEnabled: true },
    },
  });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    const empty = await requestJson(`${baseUrl}/assistant/captures/pending`, { headers });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(PendingCapturesResponseSchema.parse(empty.body), { captures: [] });

    const ingested = await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', headers, body: JSON.stringify(captureDto('a')),
    });
    assert.equal(ingested.statusCode, 200);

    const listed = await requestJson(`${baseUrl}/assistant/captures/pending`, { headers });
    assert.equal(listed.statusCode, 200);
    const { captures } = PendingCapturesResponseSchema.parse(listed.body);
    assert.equal(captures.length, 1);
    const capture = captures[0];
    assert.ok(capture);
    assert.ok(['queued', 'awaiting_image_capability', 'processing'].includes(capture.state));
    assert.equal(capture.foregroundContextKey, 'app:code|siftkit');
    assert.equal(capture.byteLength, PNG_BYTES.byteLength);
    assert.ok(capture.enqueuedAtUtc.length > 0);

    const blob = await fetch(`${baseUrl}/assistant/evidence/blob?id=${encodeURIComponent(capture.evidenceId)}`, {
      headers,
    });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), PNG_BYTES);
  } finally {
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('pending-capture list states have exactly one source of truth', () => {
  assert.deepEqual(PendingCaptureDtoSchema.shape.state.options, [...PENDING_CAPTURE_LIST_STATES]);

  const serviceSource = fs.readFileSync(path.join('src', 'assistant', 'assistant-service.ts'), 'utf8');
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_STATES/u);
  assert.doesNotMatch(serviceSource, /'queued', 'awaiting_image_capability', 'processing'/u);
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_LIMIT/u);
});
