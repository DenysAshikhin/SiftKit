import * as os from 'node:os';
import * as path from 'node:path';
import { findNearestSiftKitRepoRoot as findNearestSiftKitRepoRootShared } from '../lib/paths.js';

export function findNearestSiftKitRepoRoot(startPath: string = process.cwd()): string | null {
  return findNearestSiftKitRepoRootShared(startPath);
}

export function getRuntimeRoot(): string {
  const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  if (configuredPath && configuredPath.trim()) {
    const statusPath = path.resolve(configuredPath);
    const statusDirectory = path.dirname(statusPath);
    if (path.basename(statusDirectory).toLowerCase() === 'status') {
      return path.dirname(statusDirectory);
    }
    return statusDirectory;
  }
  const repoRoot = findNearestSiftKitRepoRoot();
  if (repoRoot) {
    return path.join(repoRoot, '.siftkit');
  }
  return path.join(process.env.USERPROFILE || os.homedir(), '.siftkit');
}

export function getStatusPath(): string {
  const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return path.join(getRuntimeRoot(), 'status', 'inference.txt');
}

export function getConfigPath(): string {
  const configuredPath = process.env.SIFTKIT_CONFIG_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return path.join(getRuntimeRoot(), 'config.json');
}

export function getMetricsPath(): string {
  const configuredPath = process.env.SIFTKIT_METRICS_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return path.join(getRuntimeRoot(), 'metrics', 'compression.json');
}

export function getIdleSummarySnapshotsPath(): string {
  const configuredPath = process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return path.join(path.dirname(getStatusPath()), 'idle-summary.sqlite');
}

export function getManagedLlamaLogRoot(): string {
  return path.join(getRuntimeRoot(), 'logs', 'managed-llama');
}
