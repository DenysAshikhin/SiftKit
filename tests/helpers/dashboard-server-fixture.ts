import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startStatusServer } from '../../src/status-server/index.js';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.js';
import { readMetrics, type Metrics } from '../../src/status-server/metrics.js';
import { writeRuntimeLaunchSnapshot } from '../../src/status-server/runtime-launch-snapshot.js';
import { closeRuntimeDatabase, getRuntimeDatabasePath } from '../../src/state/runtime-db.js';
import { getAddressInfo, removeDirectoryWithRetries } from './dashboard-http.js';

/** Points the active preset at a stand-in inference backend for engine-backed E2Es. */
export type DashboardTestBackend = {
  baseUrl: string;
  model: string;
};

const DASHBOARD_TEST_ENV_KEYS = [
  'sift_kit_status',
  'SIFTKIT_STATUS_PATH',
  'SIFTKIT_CONFIG_PATH',
  'SIFTKIT_METRICS_PATH',
  'SIFTKIT_IDLE_SUMMARY_DB_PATH',
  'SIFTKIT_STATUS_HOST',
  'SIFTKIT_STATUS_PORT',
  'SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS',
] as const;

const METRICS_SETTLE_POLL_INTERVAL_MS = 25;
const METRICS_SETTLE_QUIET_POLLS = 12;
const METRICS_SETTLE_TIMEOUT_MS = 10_000;

function sleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
}

/**
 * Boots a real status server inside a throwaway repo so route -> store -> metrics
 * wiring is exercised end to end. Every dashboard E2E needs the same temp repo,
 * env override and teardown dance; this owns it once.
 */
export class DashboardTestServer {
  private constructor(
    readonly tempRoot: string,
    readonly baseUrl: string,
    private readonly server: ReturnType<typeof startStatusServer>,
    private readonly previousCwd: string,
    private readonly envBackup: Record<string, string | undefined>,
  ) {}

  static async start(namePrefix: string, backend?: DashboardTestBackend): Promise<DashboardTestServer> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), namePrefix));
    const previousCwd = process.cwd();
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(tempRoot);

    const envBackup: Record<string, string | undefined> = {};
    for (const key of DASHBOARD_TEST_ENV_KEYS) {
      envBackup[key] = process.env[key];
    }
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = path.join(tempRoot, '.siftkit', 'config.json');
    process.env.sift_kit_status = statusPath;
    process.env.SIFTKIT_STATUS_PATH = statusPath;
    process.env.SIFTKIT_CONFIG_PATH = configPath;
    process.env.SIFTKIT_METRICS_PATH = path.join(tempRoot, '.siftkit', 'status', 'compression-metrics.json');
    process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
    process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
    process.env.SIFTKIT_STATUS_PORT = '0';
    process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS = '0';

    const server = startStatusServer({ disableManagedLlamaStartup: true });
    await server.startupPromise;
    if (backend) {
      // Config and the launch snapshot both live in the runtime database, which only
      // exists once the server has booted.
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
    const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
    return new DashboardTestServer(tempRoot, baseUrl, server, previousCwd, envBackup);
  }

  readMetrics(): Metrics {
    return readMetrics(getRuntimeDatabasePath());
  }

  /**
   * Terminal metadata drains off the request path, so a settled read needs both a
   * lower bound and proof that nothing else is still landing — a duplicate post that
   * arrives after the assert is exactly the bug these E2Es look for. Any change to the
   * snapshot restarts the quiet window, so the wait tracks real writes instead of a
   * fixed sleep.
   */
  async readSettledMetrics(minimumCompletedRequestCount: number): Promise<Metrics> {
    const deadline = Date.now() + METRICS_SETTLE_TIMEOUT_MS;
    let previousSnapshot = '';
    let unchangedPolls = 0;
    while (Date.now() < deadline) {
      const metrics = this.readMetrics();
      const snapshot = JSON.stringify(metrics);
      unchangedPolls = snapshot === previousSnapshot ? unchangedPolls + 1 : 0;
      previousSnapshot = snapshot;
      if (metrics.completedRequestCount >= minimumCompletedRequestCount && unchangedPolls >= METRICS_SETTLE_QUIET_POLLS) {
        return metrics;
      }
      await sleep(METRICS_SETTLE_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Runtime metrics never settled at >= ${minimumCompletedRequestCount} completed requests `
      + `within ${METRICS_SETTLE_TIMEOUT_MS} ms.`,
    );
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(this.previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(this.envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(this.tempRoot);
  }
}
