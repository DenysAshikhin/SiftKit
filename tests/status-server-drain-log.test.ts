import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startStatusServer } from '../src/status-server/index.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { requestJson, getAddressInfo } from './helpers/dashboard-http.js';
import { captureStdoutLines } from './helpers/stdout-capture.js';

const REQUEST_ID = 'drain-storm-request';

test('a long drain wait logs once on entry and once on resume', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-drain-log-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
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

  // Hold the llama flush queue busy so the terminal-metadata drain re-schedules
  // many times before it is allowed to run.
  const originalIsIdle = InferenceRunFlushQueue.prototype.isIdle;
  let llamaFlushIdle = false;
  InferenceRunFlushQueue.prototype.isIdle = function isIdleForTest(): boolean {
    return llamaFlushIdle && originalIsIdle.call(this);
  };
  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    const lines = await captureStdoutLines(async () => {
      await requestJson(`${baseUrl}/status`, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          taskKind: 'summary',
          requestId: REQUEST_ID,
          statusPath,
          rawInputCharacterCount: 100,
          promptCharacterCount: 200,
          promptTokenCount: 50,
        }),
      });
      await requestJson(`${baseUrl}/status/terminal-metadata`, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          taskKind: 'summary',
          requestId: REQUEST_ID,
          statusPath,
          terminalState: 'completed',
          deferredMetadata: { outputTokens: 11 },
        }),
      });
      // The drain re-schedules every second; stay busy long enough for several cycles.
      await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
      llamaFlushIdle = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    });

    const waits = lines.filter((line) => /st drain-st {2}drain_wait/u.test(line));
    const resumes = lines.filter((line) => /st drain-st {2}drain_resume/u.test(line));

    assert.equal(waits.length, 1, `the wait must be logged once, not once per cycle:\n${lines.join('\n')}`);
    assert.equal(resumes.length, 1, `the resume must report the folded run:\n${lines.join('\n')}`);
    assert.match(resumes[0], /waited=\d+m? ?\d*s {2}cycles=[2-9]\d*/u);
    assert.ok(
      lines.indexOf(waits[0]) < lines.indexOf(resumes[0]),
      `the entry line must precede the resume line:\n${lines.join('\n')}`,
    );
  } finally {
    InferenceRunFlushQueue.prototype.isIdle = originalIsIdle;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
  }
});
