import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStatusServer } from '../src/status-server/index.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { SummaryResultSchema } from '../src/summary/types.js';
import { requestSse } from './helpers/sse-http.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

type ServerHarness = { baseUrl: string; close: () => Promise<void> };

async function startHarness(namePrefix: string): Promise<ServerHarness> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), namePrefix));
  const previousCwd = process.cwd();
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'siftkit', version: '0.1.0' }), 'utf8');
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = path.join(tempRoot, '.siftkit', 'config.json');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 50 });
  await server.startupPromise;
  return {
    baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      process.chdir(previousCwd);
      closeRuntimeDatabase();
      for (const [key, value] of Object.entries(envBackup)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test('summary streams progress frames before a schema-valid result frame', async () => {
  const harness = await startHarness('siftkit-streamed-summary-');
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, {
      body: { question: 'what is in the text?', inputText: 'alpha beta gamma', backend: 'mock' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.errorMessage, null);
    assert.ok(response.result, response.rawBody);
    const firstResultIndex = response.frames.findIndex((frame) => frame.event === 'result');
    const firstProgressIndex = response.frames.findIndex((frame) => frame.event === 'progress');
    assert.ok(firstProgressIndex >= 0, 'expected at least one progress frame');
    assert.ok(firstProgressIndex < firstResultIndex, 'progress must precede result');
    assert.equal(SummaryResultSchema.parse(response.result).WasSummarized, true);
  } finally {
    await harness.close();
  }
});

test('malformed body gets a plain HTTP 400 before SSE opens', async () => {
  const harness = await startHarness('siftkit-streamed-summary-400-');
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, { body: { inputText: 'no question' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.frames.length, 0);
    assert.match(response.rawBody, /Expected question and inputText/u);
  } finally {
    await harness.close();
  }
});

test('engine failure surfaces as an error frame, not an HTTP error', async () => {
  const harness = await startHarness('siftkit-streamed-summary-err-');
  const previousBehavior = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'throw';
  try {
    const response = await requestSse(`${harness.baseUrl}/summary`, {
      body: { question: 'q', inputText: 'engine failure input', backend: 'mock' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.result, null);
    assert.match(String(response.errorMessage), /mock provider failure/u);
  } finally {
    if (previousBehavior === undefined) {
      delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
    } else {
      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = previousBehavior;
    }
    await harness.close();
  }
});

test('concurrent summary streams both complete successfully', async () => {
  const harness = await startHarness('siftkit-streamed-summary-lock-');
  try {
    const [first, second] = await Promise.all([
      requestSse(`${harness.baseUrl}/summary`, {
        body: { question: 'q1', inputText: `slow ${'y'.repeat(50)}`, backend: 'mock' },
      }),
      requestSse(`${harness.baseUrl}/summary`, {
        body: { question: 'q2', inputText: 'z text', backend: 'mock' },
      }),
    ]);
    assert.ok(first.result);
    assert.ok(second.result);
    for (const event of second.progress.filter((progress) => progress.kind === 'lock_wait')) {
      assert.equal(typeof event.queueLength, 'number');
    }
  } finally {
    await harness.close();
  }
});
