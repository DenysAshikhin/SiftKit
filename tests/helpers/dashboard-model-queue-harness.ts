import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { startStatusServer } from '../../src/status-server/index.js';
import {
  asObject,
  asObjectArray,
  getAddressInfo,
  requestJson,
  requestSse,
  type SseResponse,
} from './dashboard-http.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './temp-dirs.js';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestEnv,
  restoreDashboardTestRepo,
} from './dashboard-test-repo.js';

const QUEUE_WAIT_TIMEOUT_MS = 2_000;
const QUEUE_POLL_INTERVAL_MS = 10;
const LOCK_HOLDER_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const LOCK_HOLDER_COMMAND = 'git grep -n "x" src';

export class DashboardModelQueueHarness {
  private readonly tempRoot: string;
  private readonly previousCwd: string;
  private readonly envBackup: Record<string, string | undefined>;
  private server: ReturnType<typeof startStatusServer> | null = null;
  private baseUrl: string | null = null;

  constructor(tempDirectoryPrefix: string) {
    this.tempRoot = createManagedTempDir(tempDirectoryPrefix);
    this.previousCwd = enterDashboardTestRepo(this.tempRoot);
    const statusPath = path.join(this.tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = path.join(this.tempRoot, '.siftkit', 'config.json');
    this.envBackup = configureDashboardTestEnv(this.tempRoot, statusPath, configPath);
  }

  async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error('DashboardModelQueueHarness.start() may only be called once.');
    }
    const server = startStatusServer({ disableManagedLlamaStartup: true });
    this.server = server;
    await server.startupPromise;
    const address = getAddressInfo(server);
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  getBaseUrl(): string {
    if (this.baseUrl === null) {
      throw new Error('DashboardModelQueueHarness.start() must complete before use.');
    }
    return this.baseUrl;
  }

  async createChatSession(title: string, model: string): Promise<string> {
    const response = await requestJson(`${this.getBaseUrl()}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title, model }),
    });
    if (response.statusCode !== 201 && response.statusCode !== 200) {
      throw new Error(`Expected chat session creation to succeed, received ${response.statusCode}.`);
    }
    const sessionId = asObject(response.body.session).id;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Expected chat session creation to return a session id.');
    }
    return sessionId;
  }

  async waitForActiveRequest(kind: string): Promise<void> {
    const deadline = Date.now() + QUEUE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await requestJson(`${this.getBaseUrl()}/status`);
      const activeRequests = asObjectArray(asObject(response.body.modelRequests).activeRequests);
      if (activeRequests.some((request) => request.kind === kind)) {
        return;
      }
      await delay(QUEUE_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for active model request "${kind}".`);
  }

  async waitForQueuedRequest(kind: string): Promise<void> {
    const deadline = Date.now() + QUEUE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await requestJson(`${this.getBaseUrl()}/status`);
      const queuedRequests = asObjectArray(asObject(response.body.modelRequests).queuedRequests);
      for (const request of queuedRequests) {
        if (request.kind === kind) {
          return;
        }
      }
      await delay(QUEUE_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for queued model request "${kind}".`);
  }

  async waitForModelQueueIdle(): Promise<void> {
    const deadline = Date.now() + QUEUE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await requestJson(`${this.getBaseUrl()}/status`);
      const modelRequests = asObject(response.body.modelRequests);
      const activeRequests = asObjectArray(modelRequests.activeRequests);
      const queuedRequests = asObjectArray(modelRequests.queuedRequests);
      if (activeRequests.length === 0 && queuedRequests.length === 0) {
        return;
      }
      await delay(QUEUE_POLL_INTERVAL_MS);
    }
    throw new Error('Timed out waiting for the model request queue to become idle.');
  }

  holdModelLock(prompt: string, delayMs: number): Promise<SseResponse> {
    return requestSse(`${this.getBaseUrl()}/repo-search`, {
      method: 'POST',
      timeoutMs: 6_000,
      body: JSON.stringify({
        prompt,
        repoRoot: this.tempRoot,
        model: LOCK_HOLDER_MODEL,
        maxTurns: 1,
        simulateWorkMs: 80,
        availableModels: [LOCK_HOLDER_MODEL],
        mockResponses: [
          `{"action":"git","command":"${LOCK_HOLDER_COMMAND.replaceAll('"', '\\"')}"}`,
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          [LOCK_HOLDER_COMMAND]: {
            exitCode: 0,
            stdout: 'src/example.ts:1:x',
            stderr: '',
            delayMs,
          },
        },
      }),
    });
  }

  async close(): Promise<void> {
    try {
      const server = this.server;
      if (server !== null && server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      try {
        try {
          restoreDashboardTestEnv(this.envBackup);
        } finally {
          restoreDashboardTestRepo(this.previousCwd);
        }
      } finally {
        await removeDirectoryWithRetries(this.tempRoot);
      }
    }
  }
}
