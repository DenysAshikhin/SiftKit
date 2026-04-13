/**
 * Path resolution for the status-server.
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
  return getConfigPathShared();
}

export function getMetricsPath(): string {
  return getCompressionMetricsPath();
}

export function getIdleSummarySnapshotsPath(): string {
  return getIdleSummarySnapshotsPathShared();
}

export function getManagedLlamaLogRoot(): string {
  return path.join(getRuntimeRoot(), 'logs', 'managed-llama');
}
