import fs from 'node:fs';
import path from 'node:path';

import { closeRuntimeDatabase } from '../../src/state/runtime-db.js';

export function configureDashboardTestEnv(
  tempRoot: string,
  statusPath: string,
  configPath: string,
): Record<string, string | undefined> {
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_METRICS_PATH: process.env.SIFTKIT_METRICS_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS,
    SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE: process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_METRICS_PATH = path.join(tempRoot, '.siftkit', 'status', 'compression-metrics.json');
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS = '0';
  process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE = '1';
  return envBackup;
}

export function restoreDashboardTestEnv(envBackup: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function enterDashboardTestRepo(tempRoot: string): string {
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  return previousCwd;
}

export function restoreDashboardTestRepo(previousCwd: string): void {
  process.chdir(previousCwd);
  closeRuntimeDatabase();
}
