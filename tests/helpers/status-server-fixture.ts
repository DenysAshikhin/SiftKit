import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { acquireChildPortLease, writeManagedEngineHost } from '../_runtime-helpers.ts';
import type { ManagedEngineHostFixture } from './managed-engine-fixtures.ts';
import type { FakeTabbyLauncher, FakeTabbyOptions } from './in-process-tabby.ts';
import { FixedGpuMemoryProbe } from './fixed-gpu-memory-probe.ts';

import { startStatusServer } from '../../src/status-server/index.ts';
import { closeAllRuntimeDatabases } from '../../src/state/runtime-db.ts';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.ts';
import { getConfigPath, type ModelRuntimePreset } from '../../src/config/index.ts';
import type { JsonObject, JsonValue } from '../../src/lib/json-types.ts';
import { asObject, getAddressInfo, requestJson, type JsonResponse } from './dashboard-http.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './temp-dirs.ts';

// Healthcheck timeout must stay well above realistic localhost round-trip latency under
// full-suite CPU contention; a sub-100ms timeout made every probe to the freshly-spawned
// fake engine time out, mis-reading it as offline until the startup deadline expired (503).
// These tests exercise wake-on-demand and request translation, not tight healthcheck timing.
const PASSTHROUGH_TIMEOUTS = {
  StartupTimeoutMs: 10_000,
  HealthcheckTimeoutMs: 2_000,
  HealthcheckIntervalMs: 100,
} as const;

function writeManagedConfig(
  managed: ManagedEngineHostFixture,
  presetOverrides: Partial<ModelRuntimePreset>,
): void {
  const config = getDefaultConfig();
  const preset = config.Server.ModelPresets.Presets[0];
  config.Server.ModelPresets.Presets[0] = {
    ...preset,
    Backend: 'exl3',
    Model: managed.modelId,
    BaseUrl: managed.baseUrl,
    NumCtx: 32000,
    ModelPath: managed.modelPath,
    ...PASSTHROUGH_TIMEOUTS,
    ...presetOverrides,
  };
  config.Server.Engines.Exl3 = managed.engine;
  writeConfig(getConfigPath(), config);
}

export interface PassthroughServerOptions {
  tempPrefix: string;
  modelId: string;
  engine?: Omit<FakeTabbyOptions, 'port' | 'modelId'>;
  presetOverrides?: Partial<ModelRuntimePreset>;
  disableManagedEngineStartup?: boolean;
}

const ENV_KEYS = [
  'sift_kit_status',
  'SIFTKIT_STATUS_PATH',
  'SIFTKIT_CONFIG_PATH',
  'SIFTKIT_STATUS_HOST',
  'SIFTKIT_STATUS_PORT',
] as const;

/** A status server in its own temp workspace, proxying to a fake managed engine; disposal restores the process. */
export class PassthroughServer implements AsyncDisposable {
  readonly baseUrl: string;
  readonly managed: ManagedEngineHostFixture;
  private readonly server: http.Server;
  private readonly portLease: AsyncDisposable;
  private readonly tempRoot: string;
  private readonly previousCwd: string;
  private readonly envBackup: Map<string, string | undefined>;

  private constructor(fields: {
    server: http.Server;
    managed: ManagedEngineHostFixture;
    portLease: AsyncDisposable;
    tempRoot: string;
    previousCwd: string;
    envBackup: Map<string, string | undefined>;
  }) {
    this.server = fields.server;
    this.managed = fields.managed;
    this.portLease = fields.portLease;
    this.tempRoot = fields.tempRoot;
    this.previousCwd = fields.previousCwd;
    this.envBackup = fields.envBackup;
    this.baseUrl = `http://127.0.0.1:${getAddressInfo(fields.server).port}`;
  }

  static async start(options: PassthroughServerOptions): Promise<PassthroughServer> {
    const tempRoot = createManagedTempDir(options.tempPrefix);
    const previousCwd = process.cwd();
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(tempRoot);
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = path.join(tempRoot, '.siftkit', 'config.json');
    const envBackup = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.sift_kit_status = statusPath;
    process.env.SIFTKIT_STATUS_PATH = statusPath;
    process.env.SIFTKIT_CONFIG_PATH = configPath;
    process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
    process.env.SIFTKIT_STATUS_PORT = '0';

    const portLease = await acquireChildPortLease('inference-passthrough-status-server');
    const managed = writeManagedEngineHost(tempRoot, portLease.port, options.modelId, options.engine);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeManagedConfig(managed, options.presetOverrides ?? {});

    const server = startStatusServer({
      disableManagedEngineStartup: Boolean(options.disableManagedEngineStartup),
      managedEngineHost: managed.host,
      gpuMemoryProbe: new FixedGpuMemoryProbe(null),
    });
    await server.startupPromise;
    return new PassthroughServer({ server, managed, portLease, tempRoot, previousCwd, envBackup });
  }

  get launcher(): FakeTabbyLauncher {
    return this.managed.launcher;
  }

  postChat(body: JsonValue, headers: Record<string, string> = {}): Promise<JsonResponse> {
    return requestJson(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 30_000,
      headers,
    });
  }

  /** The body the fake engine received for a chat that must succeed. */
  async forwardedChat(body: JsonValue, headers: Record<string, string> = {}): Promise<JsonObject> {
    const response = await this.postChat(body, headers);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    return asObject(response.body.forwardedRequest);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    await this.managed.launcher.stopAll();
    process.chdir(this.previousCwd);
    closeAllRuntimeDatabases();
    for (const [key, value] of this.envBackup) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(this.tempRoot);
    await this.portLease[Symbol.asyncDispose]();
  }
}