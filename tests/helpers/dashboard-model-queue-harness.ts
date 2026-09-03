import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getDefaultConfigObject } from '../../src/config/defaults.js';
import { getActiveModelPreset } from '../../src/config/getters.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import { z } from '../../src/lib/zod.js';
import { startStatusServer } from '../../src/status-server/index.js';
import type { StatusEngineService } from '../../src/status-server/engine-service.js';
import { readConfig, writeConfig } from '../../src/status-server/config-store.js';
import { getConfigPath } from '../../src/status-server/paths.js';
import { FakeTabbyModelState } from './tabby-fake.js';
import {
  asObject,
  asObjectArray,
  getAddressInfo,
  closeHttpServer,
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

interface PendingChatRequest {
  sessionId: string;
  response: http.ServerResponse;
  released: boolean;
  aborted: boolean;
}

const ControlledChatRequestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() }).loose()),
}).loose();

function readUserContents(body: string): string[] {
  const request = ControlledChatRequestSchema.parse(parseJsonValueText(body));
  const contents: string[] = [];
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message.role === 'user') contents.push(message.content);
  }
  return contents;
}

const QUEUE_WAIT_TIMEOUT_MS = 2_000;
const QUEUE_POLL_INTERVAL_MS = 10;
const LOCK_HOLDER_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const LOCK_HOLDER_COMMAND = "git operation=\"grep\" path=\"src\" pattern=\"x\"";

export interface DashboardModelQueueHarnessOptions {
  /**
   * Boot with a real `PresetRuntimeCoordinator` whose active preset is an exl3 preset served by an
   * in-process fake TabbyAPI, so backend-aware admission is exercised over HTTP without a GPU.
   */
  exl3ActivePreset?: boolean;
  /**
   * ParallelSlots value on the active preset, controlling global queue capacity. Required so a
   * test's intended capacity is always visible at its call site rather than implied by the backend.
   */
  parallelSlots: number;
  engineService?: StatusEngineService;
}

export class DashboardModelQueueHarness {
  private readonly tempRoot: string;
  private readonly configPath: string;
  private readonly previousCwd: string;
  private readonly envBackup: Record<string, string | undefined>;
  private readonly exl3ActivePreset: boolean;
  private readonly parallelSlots: number;
  private readonly engineService: StatusEngineService | undefined;
  private readonly fakeTabbyModel = new FakeTabbyModelState();
  private fakeTabbyServer: http.Server | null = null;
  private readonly pendingChatRequests = new Map<string, PendingChatRequest>();
  private readonly chatSessionIdByContent = new Map<string, string>();
  private readonly releasedChatResponseBySessionId = new Map<string, string>();
  private readonly queuedChatResponses: string[] = [];
  private readonly abortedChatSessionIds = new Set<string>();
  private closePromise: Promise<void> | null = null;
  private server: ReturnType<typeof startStatusServer> | null = null;
  private baseUrl: string | null = null;

  constructor(tempDirectoryPrefix: string, options: DashboardModelQueueHarnessOptions) {
    this.exl3ActivePreset = options.exl3ActivePreset ?? false;
    this.parallelSlots = options.parallelSlots;
    this.engineService = options.engineService;
    this.tempRoot = createManagedTempDir(tempDirectoryPrefix);
    this.previousCwd = enterDashboardTestRepo(this.tempRoot);
    const statusPath = path.join(this.tempRoot, '.siftkit', 'status', 'inference.txt');
    this.configPath = path.join(this.tempRoot, '.siftkit', 'config.json');
    this.envBackup = configureDashboardTestEnv(this.tempRoot, statusPath, this.configPath);
  }

  async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error('DashboardModelQueueHarness.start() may only be called once.');
    }
    try {
      await this.startFakeTabby();
      const server = startStatusServer({
        disableManagedLlamaStartup: !this.exl3ActivePreset,
        engineService: this.engineService,
      });
      this.server = server;
      await server.startupPromise;
      const address = getAddressInfo(server);
      this.baseUrl = `http://127.0.0.1:${address.port}`;
    } catch (error) {
      await this.close();
      throw error;
    }
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
          response.end("data: {\"model_type\":\"model\",\"module\":1,\"modules\":1,\"status\":\"finished\"}\n\n");
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
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end('{"object":"list","data":[{"id":"model-a"}]}');
        return;
      }
      if (request.method === 'POST' && request.url === '/tokenize') {
        response.setHeader('content-type', 'application/json');
        response.end('{"count":10}');
        return;
      }
      if (request.method === 'GET' && request.url === '/health') {
        response.setHeader('content-type', 'application/json');
        response.end('{"ok":true}');
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { body += chunk; });
        request.on('end', () => {
          let sessionId = '';
          const userContents = readUserContents(body);
          for (const content of userContents) {
            const exactSessionId = this.chatSessionIdByContent.get(content);
            if (exactSessionId) {
              sessionId = exactSessionId;
              break;
            }
            const wrappedMatches = [...this.chatSessionIdByContent]
              .filter(([registeredContent]) => content.includes(registeredContent));
            if (wrappedMatches.length > 1) {
              response.statusCode = 500;
              response.end('{"error":"Ambiguous controlled chat session."}');
              return;
            }
            sessionId = wrappedMatches[0]?.[1] ?? '';
            if (sessionId) break;
          }
          if (!sessionId) {
            response.statusCode = 500;
            response.end('{"error":"Missing controlled chat session."}');
            return;
          }
          const pending: PendingChatRequest = {
            sessionId,
            response,
            released: false,
            aborted: false,
          };
          this.pendingChatRequests.set(sessionId, pending);
          if (this.abortedChatSessionIds.has(sessionId)) {
            pending.aborted = true;
            this.pendingChatRequests.delete(sessionId);
            response.statusCode = 499;
            response.end('{"error":"Controlled chat stream aborted."}');
            return;
          }
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const onAbort = (): void => {
            if (pending.released || pending.aborted) return;
            pending.aborted = true;
            this.pendingChatRequests.delete(sessionId);
            response.destroy();
          };
          request.on('aborted', onAbort);
          response.on('close', onAbort);
          const releasedResponse = this.releasedChatResponseBySessionId.get(sessionId);
          if (releasedResponse !== undefined) {
            this.completeChatResponse(pending, releasedResponse);
            return;
          }
          const queuedResponse = this.queuedChatResponses.shift();
          if (queuedResponse !== undefined) {
            this.releasedChatResponseBySessionId.set(sessionId, queuedResponse);
            this.completeChatResponse(pending, queuedResponse);
          }
        });
        request.resume();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end('{"object":"list","data":[]}');
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      fakeTabby.once('error', onError);
      fakeTabby.listen(0, '127.0.0.1', () => {
        fakeTabby.off('error', onError);
        resolve();
      });
    });
    this.fakeTabbyServer = fakeTabby;

    const config = getDefaultConfigObject();
    const basePreset = config.Server.ModelPresets.Presets[0];
    if (!basePreset) throw new Error('Default model preset is missing');
    const fakeBaseUrl = `http://127.0.0.1:${getAddressInfo(fakeTabby).port}`;
    if (this.exl3ActivePreset) {
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
          BaseUrl: fakeBaseUrl,
          Model: 'model-a',
          ModelPath: path.join(this.tempRoot, 'model-a'),
          ParallelSlots: this.parallelSlots,
          HealthcheckIntervalMs: 10,
        }],
      };
    } else {
      config.Server.ModelPresets = {
        ActivePresetId: 'llama-main',
        Presets: [{
          ...basePreset,
          id: 'llama-main',
          label: 'llama.cpp main',
          Backend: 'llama',
          BaseUrl: fakeBaseUrl,
          ExternalServerEnabled: true,
          Model: 'model-a',
          ModelPath: null,
          ParallelSlots: this.parallelSlots,
        }],
      };
    }
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

  async updateParallelSlots(parallelSlots: number): Promise<void> {
    const config = readConfig(getConfigPath());
    getActiveModelPreset(config).ParallelSlots = parallelSlots;
    const response = await requestJson(`${this.getBaseUrl()}/config?skip_ready=1`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    if (response.statusCode !== 200) {
      throw new Error(`Expected config update to succeed, received ${response.statusCode}.`);
    }
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

  startChatStream(sessionId: string, content: string, operationId = randomUUID()): Promise<SseResponse> {
    return this.startChatOperationStream('message', sessionId, content, operationId);
  }

  startChatOperationStream(
    operationKind: 'message' | 'plan' | 'repo-search',
    sessionId: string,
    content: string,
    operationId = randomUUID(),
  ): Promise<SseResponse> {
    this.chatSessionIdByContent.set(content, sessionId);
    const segment = operationKind === 'message' ? 'messages' : operationKind;
    return requestSse(`${this.getBaseUrl()}/dashboard/chat/sessions/${sessionId}/${segment}/stream`, {
      method: 'POST',
      timeoutMs: 30_000,
      body: JSON.stringify({ content, operationId, repoRoot: this.tempRoot }),
    });
  }

  releaseChatResponse(content: string): void {
    for (const pending of this.pendingChatRequests.values()) {
      if (pending.released || pending.aborted) {
        continue;
      }
      this.releasedChatResponseBySessionId.set(pending.sessionId, content);
      this.completeChatResponse(pending, content);
      return;
    }
    this.queuedChatResponses.push(content);
  }

  abortChatStream(sessionId: string): void {
    this.abortedChatSessionIds.add(sessionId);
    const pending = this.pendingChatRequests.get(sessionId) ?? null;
    if (pending === null) return;
    if (pending.released || pending.aborted) return;
    pending.aborted = true;
    pending.response.write('data: [DONE]\n\n');
    pending.response.end();
    this.pendingChatRequests.delete(sessionId);
  }

  private completeChatResponse(pending: PendingChatRequest, content: string): void {
    pending.released = true;
    pending.response.write(`data: ${JSON.stringify({
      id: `chatcmpl-${pending.sessionId}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content } }],
    })}\n\n`);
    pending.response.write(`data: ${JSON.stringify({
      id: `chatcmpl-${pending.sessionId}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`);
    pending.response.write('data: [DONE]\n\n');
    pending.response.end();
    this.pendingChatRequests.delete(pending.sessionId);
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
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"x","path":"src"} }] },
          { content: "done" },
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

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    try {
      for (const pending of this.pendingChatRequests.values()) {
        pending.response.destroy();
      }
      this.pendingChatRequests.clear();
      this.chatSessionIdByContent.clear();
      this.releasedChatResponseBySessionId.clear();
      this.queuedChatResponses.length = 0;
      this.abortedChatSessionIds.clear();
      try {
        const server = this.server;
        if (server !== null && server.listening) {
          await closeHttpServer(server);
        }
      } finally {
        const fakeTabby = this.fakeTabbyServer;
        if (fakeTabby !== null) {
          await closeHttpServer(fakeTabby);
        }
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
