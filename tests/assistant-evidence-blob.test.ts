import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { CaptureSubmissionDto } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function captureDto(): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: '2026-08-10T14:03:11.000Z',
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
    pixelSha256: '1'.repeat(64),
    perceptualHash: 'f0e1d2c3b4a59687',
    imageDataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  };
}

function listEvidenceBlobFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else files.push(entryPath);
    }
  };
  walk(root);
  return files;
}

test('the evidence blob route decrypts pixels for the owner and never caches them', async () => {
  const tempRoot = createManagedTempDir('siftkit-evidence-blob-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  const enabled = {
    ...initial.Assistant,
    Enabled: true,
    Observation: { ...initial.Assistant.Observation, ScreenshotsEnabled: true },
  };
  writeConfig(getConfigPath(), { ...initial, Assistant: enabled });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    const accepted = await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', headers, body: JSON.stringify(captureDto()),
    });
    assert.equal(accepted.statusCode, 200);
    const database = getRuntimeDatabase(path.join(tempRoot, '.siftkit', 'runtime.sqlite'));
    const evidenceRow = database
      .prepare("SELECT id FROM evidence_records WHERE source_type = 'screenshot'")
      .get();
    const evidenceId = typeof evidenceRow === 'object' && evidenceRow !== null
      && 'id' in evidenceRow && typeof evidenceRow.id === 'string'
      ? evidenceRow.id
      : '';
    assert.notEqual(evidenceId, '', 'the capture wrote screenshot evidence');

    const unauthorized = await fetch(`${baseUrl}/assistant/evidence/blob?id=${evidenceId}`);
    assert.equal(unauthorized.status, 401, 'pixels require the bearer');

    const revealed = await fetch(`${baseUrl}/assistant/evidence/blob?id=${evidenceId}`, { headers });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.headers.get('cache-control'), 'no-store');
    assert.equal(revealed.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await revealed.arrayBuffer()), PNG_BYTES);

    const missing = await fetch(`${baseUrl}/assistant/evidence/blob?id=ev_missing`, { headers });
    assert.equal(missing.status, 404);

    database.prepare("UPDATE evidence_records SET status = 'expired' WHERE id = ?").run(evidenceId);
    const expired = await fetch(`${baseUrl}/assistant/evidence/blob?id=${evidenceId}`, { headers });
    assert.equal(expired.status, 404, 'expired evidence never serves bytes');
    database.prepare("UPDATE evidence_records SET status = 'active' WHERE id = ?").run(evidenceId);

    const blobFiles = listEvidenceBlobFiles(
      path.join(tempRoot, '.siftkit', 'assistant', 'evidence'),
    );
    assert.equal(blobFiles.length, 1);
    const blobPath = blobFiles[0] ?? '';
    const envelope = fs.readFileSync(blobPath);
    const tampered = Buffer.from(envelope);
    const lastIndex = tampered.byteLength - 1;
    tampered[lastIndex] = (envelope[lastIndex] ?? 0) ^ 0xff;
    fs.writeFileSync(blobPath, tampered);

    const corrupt = await fetch(`${baseUrl}/assistant/evidence/blob?id=${evidenceId}`, { headers });
    assert.equal(corrupt.status, 500, 'a tampered blob is an error, never bytes');
    const corruptBody = await corrupt.text();
    assert.ok(!corruptBody.includes(PNG_BYTES.toString('base64')));
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
