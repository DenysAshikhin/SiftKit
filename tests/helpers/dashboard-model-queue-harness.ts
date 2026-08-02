import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getDefaultConfigObject } from '../../src/config/defaults.js';
import { startStatusServer } from '../../src/status-server/index.js';
import { writeConfig } from '../../src/status-server/config-store.js';
import { getConfigPath } from '../../src/status-server/paths.js';
import { FakeTabbyModelState } from './tabby-fake.js';
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

export interface DashboardModelQueueHarnessOptions {
  /**
   * Boot with a real `PresetRuntimeCoordinator` whose active preset is an exl3 preset served by an
   * in-process fake TabbyAPI, so backend-aware admission is exercised over HTTP without a GPU.
   */
  exl3ActivePreset?: boolean;
}

export class DashboardModelQueueHarness {
  private readonly tempRoot: string;
  private readonly configPath: string;
  private readonly previousCwd: string;
  private readonly envBackup: Record<string, string | undefined>;
  private readonly exl3ActivePreset: boolean;
  private readonly fakeTabbyModel = new FakeTabbyModelState();
  private fakeTabbyServer: http.Server | null = null;
  private server: ReturnType<typeof startStatusServer> | null = null;
  private baseUrl: string | null = null;

  constructor(tempDirectoryPrefix: string, options: DashboardModelQueueHarnessOptions = {}) {
    this.tempRoot = createManagedTempDir(tempDirectoryPrefix);
    this.previousCwd = enterDashboardTestRepo(this.tempRoot);
    const statusPath = path.join(this.tempRoot, '.siftkit', 'status', 'inference.txt');
    this.configPath = path.join(this.tempRoot, '.siftkit', 'config.json');
    this.envBackup = configureDashboardTestEnv(this.tempRoot, statusPath, this.configPath);
    this.exl3ActivePreset = options.exl3ActivePreset ?? false;
  }

  async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error('DashboardModelQueueHarness.start() may only be called once.');
    }
    if (this.exl3ActivePreset) {
      await this.startFakeTabby();
    }
    const server = startStatusServer({ disableManagedLlamaStartup: !this.exl3ActivePreset });
    this.server = server;
    await server.startupPromise;
    const address = getAddressInfo(server);
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  /**
   * TabbyAPI's load/unload/model-card surface, enough for `ManagedTabbyRuntime` to drive an
   * engine SiftKit does not own (`Managed: false`), which needs no child process at all.
   */
  private async startFakeTabby(): Promise<void> {
    const fakeTabby = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/model/load') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          this.fakeTabbyModel.applyLoad(body);
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/model/unload') {
        this.fakeTabbyModel.clear();
        response.statusCode = 200;
        response.end();
        return;
      }
      if (request.url === '/v1/model') {
        this.fakeTabbyModel.respondCurrentModel(response);
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end('{"object":"list","data":[]}');
    });
    await new Promise<void>((resolve) => fakeTabby.listen(0, '127.0.0.1', resolve));
    this.fakeTabbyServer = fakeTabby;

    const config = getDefaultConfigObject();
    const basePreset = config.Server.ModelPresets.Presets[0];
    if (!basePreset) throw new Error('Default model preset is missing');
    config.Server.Engines.Exl3 = {
      Managed: false,
      WorkingDirectory: this.tempRoot,
      PythonPath: process.execPath,
      Entrypoint: 'unused',
      ModelRoot: this.tempRoot,
      AdminApiKey: '',
      ShutdownTimeoutMs: 2_000,
    };
    config.Server.ModelPresets = {
      ActivePresetId: 'exl3-main',
      Presets: [{
        ...basePreset,
        id: 'exl3-main',
        label: 'EXL3 main',
        Backend: 'exl3',
        BaseUrl: `http://127.0.0.1:${getAddressInfo(fakeTabby).port}`,
        Model: 'model-a',
        ModelPath: path.join(this.tempRoot, 'model-a'),
        ParallelSlots: 4,
        HealthcheckIntervalMs: 10,
      }],
    };
    // The server resolves its config from the runtime database under the repo it runs in, so the
    // preset has to be persisted there rather than at the SIFTKIT_CONFIG_PATH override.
    writeConfig(getConfigPath(), config);
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

  /** Waits until at least `count` active model requests report `kind`. */
  async waitForActiveRequests(kind: string, count = 1): Promise<void> {
    const deadline = Date.now() + QUEUE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await requestJson(`${this.getBaseUrl()}/status`);
      const activeRequests = asObjectArray(asObject(response.body.modelRequests).activeRequests);
      if (activeRequests.filter((request) => request.kind === kind).length >= count) {
        return;
      }
      await delay(QUEUE_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for ${count} active model request(s) "${kind}".`);
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
      const fakeTabby = this.fakeTabbyServer;
      if (fakeTabby !== null) {
        await new Promise<void>((resolve, reject) => {
          fakeTabby.close((error) => (error ? reject(error) : resolve()));
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
