import { dirname, join, resolve } from 'node:path';
import { ensureDirectory } from '../lib/fs.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';
import {
  getRepoRuntimeRoot,
  getRuntimeDatabasePath as getRuntimeDatabasePathShared,
} from '../state/runtime-db.js';

/**
 * Resolved runtime directory layout. Produced by `initializeRuntime()` and
 * surfaced through `SiftConfig.Paths` for consumers that want the
 * pre-computed set.
 */
export type RuntimePaths = {
  RuntimeRoot: string;
  Logs: string;
  EvalFixtures: string;
  EvalResults: string;
};

export function getRepoLocalRuntimeRoot(): string | null {
  const repoRoot = findNearestSiftKitRepoRoot();
  return repoRoot ? resolve(repoRoot, '.siftkit') : null;
}

export function getRepoLocalLogsPath(): string | null {
  const runtimeRoot = getRepoLocalRuntimeRoot();
  return runtimeRoot ? resolve(runtimeRoot, 'logs') : null;
}

export function getRuntimeRoot(): string {
  return getRepoRuntimeRoot();
}

/** Creates (mkdir -p) the standard runtime subdirectories and returns their paths. */
export function initializeRuntime(): RuntimePaths {
  const runtimeRoot = ensureDirectory(getRuntimeRoot());
  const logs = ensureDirectory(join(runtimeRoot, 'logs'));
  const evalRoot = ensureDirectory(join(runtimeRoot, 'eval'));
  const evalFixtures = ensureDirectory(join(evalRoot, 'fixtures'));
  const evalResults = ensureDirectory(join(evalRoot, 'results'));

  return {
    RuntimeRoot: runtimeRoot,
    Logs: logs,
    EvalFixtures: evalFixtures,
    EvalResults: evalResults,
  };
}

// ---------- top-level ---------- //

export function getRuntimeDatabasePath(): string {
  return getRuntimeDatabasePathShared();
}

export function getConfigPath(): string {
  return getRuntimeDatabasePath();
}

// ---------- status/ ---------- //

export function getStatusDirectory(): string {
  return join(getRuntimeRoot(), 'status');
}

export function getInferenceStatusPath(): string {
  return getRuntimeDatabasePath();
}

export function getIdleSummarySnapshotsPath(): string {
  return getRuntimeDatabasePath();
}

// ---------- metrics/ ---------- //

export function getMetricsDirectory(): string {
  return join(getRuntimeRoot(), 'metrics');
}

export function getObservedBudgetStatePath(): string {
  return getRuntimeDatabasePath();
}

export function getCompressionMetricsPath(): string {
  return getRuntimeDatabasePath();
}

// ---------- logs/ ---------- //

export function getRuntimeLogsPath(): string {
  return join(getRuntimeRoot(), 'logs');
}

export function getSummaryRequestLogsDirectory(): string {
  return join(getRuntimeLogsPath(), 'requests');
}

export function getSummaryRequestLogPath(requestId: string): string {
  return join(getSummaryRequestLogsDirectory(), `request_${requestId}.json`);
}

export function getPlannerFailedLogsDirectory(): string {
  return join(getRuntimeLogsPath(), 'failed');
}

export function getPlannerFailedPath(requestId: string): string {
  return join(getPlannerFailedLogsDirectory(), `request_failed_${requestId}.json`);
}

export function getPlannerDebugPath(requestId: string): string {
  return join(getRuntimeLogsPath(), `planner_debug_${requestId}.json`);
}

export function getAbandonedLogsDirectory(): string {
  return join(getRuntimeLogsPath(), 'abandoned');
}

export function getAbandonedRequestPath(requestId: string): string {
  return join(getAbandonedLogsDirectory(), `request_abandoned_${requestId}.json`);
}

// ---------- logs/repo_search/ ---------- //

export function getRepoSearchLogRoot(): string {
  return join(getRuntimeLogsPath(), 'repo_search');
}

export function getRepoSearchSuccessfulDirectory(): string {
  return join(getRepoSearchLogRoot(), 'succesful');
}

export function getRepoSearchFailedDirectory(): string {
  return join(getRepoSearchLogRoot(), 'failed');
}

// ---------- chat/sessions/ ---------- //

export function getChatSessionsRoot(): string {
  return join(getRuntimeRoot(), 'chat', 'sessions');
}

export function getChatSessionPath(sessionId: string): string {
  return join(getChatSessionsRoot(), `session_${sessionId}.json`);
}
