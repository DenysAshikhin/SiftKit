import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureDirectory,
  writeUtf8NoBom,
} from '../lib/fs.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';

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

function getConfiguredStatusPath(): string {
  const primary = process.env.sift_kit_status;
  if (primary && primary.trim()) {
    return primary.trim();
  }

  const secondary = process.env.SIFTKIT_STATUS_PATH;
  return secondary && secondary.trim() ? secondary.trim() : '';
}

function isRuntimeRootWritable(candidate: string | null | undefined): boolean {
  if (!candidate || !candidate.trim()) {
    return false;
  }

  try {
    const fullPath = path.resolve(candidate);
    ensureDirectory(fullPath);
    const probePath = path.join(fullPath, `${Math.random().toString(16).slice(2)}.tmp`);
    writeUtf8NoBom(probePath, 'probe');
    fs.rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function getRepoLocalRuntimeRoot(): string | null {
  const repoRoot = findNearestSiftKitRepoRoot();
  return repoRoot ? path.resolve(repoRoot, '.siftkit') : null;
}

export function getRepoLocalLogsPath(): string | null {
  const runtimeRoot = getRepoLocalRuntimeRoot();
  return runtimeRoot ? path.resolve(runtimeRoot, 'logs') : null;
}

/**
 * Resolves the active runtime-root directory by inspecting (in order):
 *   1. `sift_kit_status` / `SIFTKIT_STATUS_PATH` env vars — the caller points
 *      at a status file, we walk up to find the runtime root containing
 *      `<root>/status/inference.txt`.
 *   2. The repo-local `.siftkit/` directory under the nearest SiftKit repo.
 *   3. `%USERPROFILE%/.siftkit`.
 *   4. `<cwd>/.codex/siftkit`.
 *   5. `%TEMP%/siftkit` as a last resort.
 *
 * Each candidate is tested for writability before being returned.
 */
export function getRuntimeRoot(): string {
  const configuredStatusPath = getConfiguredStatusPath();
  if (configuredStatusPath) {
    const absoluteStatusPath = path.resolve(configuredStatusPath);
    const statusDirectory = path.dirname(absoluteStatusPath);
    if (path.basename(statusDirectory).toLowerCase() === 'status') {
      return path.resolve(path.dirname(statusDirectory));
    }

    return path.resolve(statusDirectory);
  }

  const candidates: string[] = [];
  const repoRoot = findNearestSiftKitRepoRoot();
  if (repoRoot) {
    candidates.push(path.resolve(repoRoot, '.siftkit'));
  }
  if (process.env.USERPROFILE?.trim()) {
    candidates.push(path.resolve(process.env.USERPROFILE, '.siftkit'));
  }
  if (process.cwd()) {
    candidates.push(path.resolve(process.cwd(), '.codex', 'siftkit'));
  }

  for (const candidate of candidates) {
    if (isRuntimeRootWritable(candidate)) {
      return candidate;
    }
  }

  if (candidates.length > 0) {
    return candidates[0];
  }

  return path.resolve(os.tmpdir(), 'siftkit');
}

/** Creates (mkdir -p) the standard runtime subdirectories and returns their paths. */
export function initializeRuntime(): RuntimePaths {
  const runtimeRoot = ensureDirectory(getRuntimeRoot());
  const logs = ensureDirectory(path.join(runtimeRoot, 'logs'));
  const evalRoot = ensureDirectory(path.join(runtimeRoot, 'eval'));
  const evalFixtures = ensureDirectory(path.join(evalRoot, 'fixtures'));
  const evalResults = ensureDirectory(path.join(evalRoot, 'results'));

  return {
    RuntimeRoot: runtimeRoot,
    Logs: logs,
    EvalFixtures: evalFixtures,
    EvalResults: evalResults,
  };
}

// ---------- top-level files ---------- //

export function getConfigPath(): string {
  return path.join(getRuntimeRoot(), 'config.json');
}

// ---------- status/ ---------- //

export function getStatusDirectory(): string {
  return path.join(getRuntimeRoot(), 'status');
}

export function getInferenceStatusPath(): string {
  const configuredPath = process.env.sift_kit_status;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }
  return path.join(getStatusDirectory(), 'inference.txt');
}

export function getIdleSummarySnapshotsPath(): string {
  return path.join(getStatusDirectory(), 'idle-summary.sqlite');
}

// ---------- metrics/ ---------- //

export function getMetricsDirectory(): string {
  return path.join(getRuntimeRoot(), 'metrics');
}

export function getObservedBudgetStatePath(): string {
  return path.join(getMetricsDirectory(), 'observed-budget.json');
}

export function getCompressionMetricsPath(): string {
  return path.join(getMetricsDirectory(), 'compression.json');
}

// ---------- logs/ ---------- //

export function getRuntimeLogsPath(): string {
  return path.join(getRuntimeRoot(), 'logs');
}

export function getSummaryRequestLogsDirectory(): string {
  return path.join(getRuntimeLogsPath(), 'requests');
}

export function getSummaryRequestLogPath(requestId: string): string {
  return path.join(getSummaryRequestLogsDirectory(), `request_${requestId}.json`);
}

export function getPlannerFailedLogsDirectory(): string {
  return path.join(getRuntimeLogsPath(), 'failed');
}

export function getPlannerFailedPath(requestId: string): string {
  return path.join(getPlannerFailedLogsDirectory(), `request_failed_${requestId}.json`);
}

export function getPlannerDebugPath(requestId: string): string {
  return path.join(getRuntimeLogsPath(), `planner_debug_${requestId}.json`);
}

export function getAbandonedLogsDirectory(): string {
  return path.join(getRuntimeLogsPath(), 'abandoned');
}

export function getAbandonedRequestPath(requestId: string): string {
  return path.join(getAbandonedLogsDirectory(), `request_abandoned_${requestId}.json`);
}

// ---------- logs/repo_search/ ---------- //

export function getRepoSearchLogRoot(): string {
  return path.join(getRuntimeLogsPath(), 'repo_search');
}

// Historic spelling kept for backwards compatibility with on-disk layouts
// already created by older server builds.
export function getRepoSearchSuccessfulDirectory(): string {
  return path.join(getRepoSearchLogRoot(), 'succesful');
}

export function getRepoSearchFailedDirectory(): string {
  return path.join(getRepoSearchLogRoot(), 'failed');
}

// ---------- chat/sessions/ ---------- //

export function getChatSessionsRoot(): string {
  return path.join(getRuntimeRoot(), 'chat', 'sessions');
}

export function getChatSessionPath(sessionId: string): string {
  return path.join(getChatSessionsRoot(), `session_${sessionId}.json`);
}
