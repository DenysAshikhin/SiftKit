import path from 'node:path';

import { startStatusServer } from '../../src/status-server/index.js';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.js';
import { readMetrics, type Metrics } from '../../src/status-server/metrics.js';
import { writeRuntimeLaunchSnapshot } from '../../src/status-server/runtime-launch-snapshot.js';
import { getRuntimeDatabasePath } from '../../src/state/runtime-db.js';
import { closeHttpServer, getAddressInfo } from './dashboard-http.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './temp-dirs.js';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestEnv,
  restoreDashboardTestRepo,
} from './dashboard-test-repo.js';

/** Points the active preset at a stand-in inference backend for engine-backed E2Es. */
export type DashboardTestBackend = {
  baseUrl: string;
  model: string;
};

/**
 * Managed startup is off by default so E2Es never spawn a real llama.cpp. Turning it on
 * gives the server a live PresetRuntimeCoordinator, which initializes against whatever
 * backend was seeded before boot.
 */
export type DashboardTestServerOptions = {
  managedLlamaStartup?: boolean;
};

const METRICS_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Boots a real status server inside a throwaway repo so route -> store -> metrics
 * wiring is exercised end to end. Every dashboard E2E needs the same temp repo,
 * env override and teardown dance; this owns it once.
 */
export class DashboardTestServer {
  private closePromise: Promise<void> | null = null;

  private constructor(
    readonly tempRoot: string,
    readonly baseUrl: string,
    private readonly server: ReturnType<typeof startStatusServer>,
    private readonly previousCwd: string,
    private readonly envBackup: Record<string, string | undefined>,
  ) {}

  private static seedExternalBackendConfig(backend: DashboardTestBackend): void {
    // Config and the launch snapshot both live in the runtime database.
    const databasePath = getRuntimeDatabasePath();
    const config = getDefaultConfig();
    const modelPresets = config.Server.ModelPresets;
    const activePreset = modelPresets.Presets.find((preset) => preset.id === modelPresets.ActivePresetId)
      ?? modelPresets.Presets[0];
    activePreset.ExternalServerEnabled = true;
    activePreset.Model = backend.model;
    activePreset.BaseUrl = backend.baseUrl;
    modelPresets.ActivePresetId = activePreset.id;
    writeConfig(databasePath, config);
    // Runtime.LlamaCpp wins over the preset in getConfiguredLlamaBaseUrl, so the
    // launch snapshot is what actually routes inference at request time.
    writeRuntimeLaunchSnapshot(databasePath, {
      Model: backend.model,
      LlamaCpp: {
        BaseUrl: backend.baseUrl,
        NumCtx: activePreset.NumCtx,
        Reasoning: activePreset.Reasoning,
      },
    });
  }

  static async start(
    namePrefix: string,
    backend?: DashboardTestBackend,
    options: DashboardTestServerOptions = {},
  ): Promise<DashboardTestServer> {
    const tempRoot = createManagedTempDir(namePrefix);
    const previousCwd = enterDashboardTestRepo(tempRoot);
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = path.join(tempRoot, '.siftkit', 'config.json');
    const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
    let server: ReturnType<typeof startStatusServer> | null = null;
    try {
      // The coordinator resolves its preset during startup, so config must land first.
      if (backend) DashboardTestServer.seedExternalBackendConfig(backend);
      server = startStatusServer({ disableManagedLlamaStartup: options.managedLlamaStartup !== true });
      await server.startupPromise;
      const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
      return new DashboardTestServer(tempRoot, baseUrl, server, previousCwd, envBackup);
    } catch (error) {
      await DashboardTestServer.releaseResources(tempRoot, previousCwd, envBackup, server);
      throw error;
    }
  }

  readMetrics(): Metrics {
    return readMetrics(getRuntimeDatabasePath());
  }

  /** Reads once after the server's terminal-metadata queue reaches observable idle state. */
  async readMetricsAfterTerminalMetadata(minimumCompletedRequestCount: number): Promise<Metrics> {
    await this.server.waitForTerminalMetadataIdle(
      METRICS_SETTLE_TIMEOUT_MS,
      minimumCompletedRequestCount,
    );
    const metrics = this.readMetrics();
    if (metrics.completedRequestCount < minimumCompletedRequestCount) {
      throw new Error(
        `Runtime metrics completedRequestCount=${metrics.completedRequestCount}; `
        + `expected at least ${minimumCompletedRequestCount} after terminal metadata became idle.`,
      );
    }
    return metrics;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    await DashboardTestServer.releaseResources(
      this.tempRoot,
      this.previousCwd,
      this.envBackup,
      this.server,
    );
  }

  private static async releaseResources(
    tempRoot: string,
    previousCwd: string,
    envBackup: Record<string, string | undefined>,
    server: ReturnType<typeof startStatusServer> | null,
  ): Promise<void> {
    try {
      if (server?.listening) {
        await closeHttpServer(server);
      }
    } finally {
      try {
        restoreDashboardTestEnv(envBackup);
      } finally {
        try {
          restoreDashboardTestRepo(previousCwd);
        } finally {
          await removeDirectoryWithRetries(tempRoot);
        }
      }
    }
  }
}
