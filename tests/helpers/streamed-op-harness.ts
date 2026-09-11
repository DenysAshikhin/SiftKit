import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { awaitRepoSearchRunPersistence } from '../../src/repo-search/execute.js';
import { startStatusServer } from '../../src/status-server/index.js';
import type { StatusEngineService } from '../../src/status-server/engine-service.js';
import { closeRuntimeDatabase } from '../../src/state/runtime-db.js';
import { getConfigPath } from '../../src/config/index.js';
import { writeConfig } from '../../src/status-server/config-store.js';
import { getDefaultServerConfig } from './mock-config.js';
import { asObject, asObjectArray, getAddressInfo, requestJson } from './dashboard-http.js';
import { createManagedTempDir } from './temp-dirs.js';

export type StreamedOperationHarness = {
  baseUrl: string;
  /** Stops the server and starts a fresh one over the same runtime root, as a process restart would. */
  restart: () => Promise<void>;
  close: () => Promise<void>;
};
export type StreamedOperationHarnessOptions = { engineService?: StatusEngineService };

const MODEL_REQUEST_OWNER_TIMEOUT_MS = 2_000;
const MODEL_REQUEST_OWNER_POLL_INTERVAL_MS = 10;

export async function waitForActiveModelRequestOwner(baseUrl: string): Promise<string> {
  const deadline = Date.now() + MODEL_REQUEST_OWNER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await requestJson(`${baseUrl}/status`);
    const activeRequests = asObjectArray(asObject(status.body.modelRequests).activeRequests);
    for (const activeRequest of activeRequests) {
      const ownerRunId = String(activeRequest.ownerRunId || '').trim();
      if (ownerRunId) {
        return ownerRunId;
      }
    }
    await delay(MODEL_REQUEST_OWNER_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for an active model request owner at ${baseUrl}.`);
}

/**
 * Boots a status server in an isolated temp repo and registers its own teardown on `t`.
 *
 * Teardown must be a test hook rather than a `finally` block. `startHarness` chdirs into the
 * temp repo, and node:test cannot cancel the promise of a test it timed out — so a `finally`
 * that never runs leaves every later test in the file executing from a deleted temp directory.
 * `t.after` runs regardless of how the test ended.
 */
export async function startHarness(
  namePrefix: string,
  t: TestContext,
  options: StreamedOperationHarnessOptions = {},
): Promise<StreamedOperationHarness> {
  const tempRoot = createManagedTempDir(namePrefix);
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
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = path.join(tempRoot, '.siftkit', 'config.json');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  writeConfig(getConfigPath(), getDefaultServerConfig());
  const startServer = async (): Promise<ReturnType<typeof startStatusServer>> => {
    const started = startStatusServer({
      disableManagedEngineStartup: true,
      terminalMetadataIdleDelayMs: 50,
      engineService: options.engineService,
    });
    await started.startupPromise;
    return started;
  };
  let server = await startServer();
  const publishBaseUrl = (): string => {
    const url = `http://127.0.0.1:${getAddressInfo(server).port}`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `${url}/config`;
    process.env.SIFTKIT_STATUS_BACKEND_URL = `${url}/status`;
    return url;
  };
  const stopServer = async (): Promise<void> => {
    // server.close() stops the listener but waits for open connections, and its callback never
    // fires while one is held. Awaiting it first would hang teardown on exactly the stuck
    // stream teardown exists to clean up.
    server.closeAllConnections();
    await server.waitForRequestsIdle();
    // Deferred run-log writes land after the operation resolves; let them finish before the
    // database closes, or the late write reopens runtime.sqlite inside the temp root.
    await awaitRepoSearchRunPersistence();
    // close() waits for HTTP requests, but their deferred metadata can still be queued.
    // Drain it before restoring cwd so no callback resolves a different runtime database.
    await server.waitForTerminalMetadataIdle();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  let closed = false;
  const harness: StreamedOperationHarness = {
    baseUrl: publishBaseUrl(),
    async restart() {
      await stopServer();
      closeRuntimeDatabase();
      server = await startServer();
      harness.baseUrl = publishBaseUrl();
    },
    async close() {
      // Idempotent: the registered hook always runs, and callers may also close early.
      if (closed) {
        return;
      }
      closed = true;
      await stopServer();
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
  t.after(() => harness.close());
  return harness;
}
