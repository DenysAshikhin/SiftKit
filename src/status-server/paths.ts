/**
 * Path resolution for the status-server. Delegates to `config/paths.ts` for
 * the canonical runtime-root and status-file resolution, and adds only the
 * server-specific paths (managed llama logs, re-export of env-var overrides).
 */
import * as path from 'node:path';
import {
  getRuntimeRoot as getRuntimeRootShared,
  getInferenceStatusPath,
  getConfigPath as getConfigPathShared,
  getCompressionMetricsPath,
  getIdleSummarySnapshotsPath as getIdleSummarySnapshotsPathShared,
} from '../config/paths.js';
import { findNearestSiftKitRepoRoot as findNearestSiftKitRepoRootShared } from '../lib/paths.js';

export function findNearestSiftKitRepoRoot(startPath: string = process.cwd()): string | null {
  return findNearestSiftKitRepoRootShared(startPath);
}

export function getRuntimeRoot(): string {
  return getRuntimeRootShared();
}

export function getStatusPath(): string {
  return getInferenceStatusPath();
}

export function getConfigPath(): string {
  const configuredPath = process.env.SIFTKIT_CONFIG_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return getConfigPathShared();
}

export function getMetricsPath(): string {
  const configuredPath = process.env.SIFTKIT_METRICS_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return getCompressionMetricsPath();
}

export function getIdleSummarySnapshotsPath(): string {
  const configuredPath = process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return getIdleSummarySnapshotsPathShared();
}

export function getManagedLlamaLogRoot(): string {
  return path.join(getRuntimeRoot(), 'logs', 'managed-llama');
}
