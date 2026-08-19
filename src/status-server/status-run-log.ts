import type { OptionalJsonValue } from '../lib/json-types.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { getActiveModelPreset, readConfig } from './config-store.js';
import {
  upsertRunLog,
  type RunLogGroup,
  type RunLogKind,
} from './dashboard-runs.js';
import type { TaskKind, ToolTypeStats } from './metrics.js';
import { serverLogger } from './server-logger.js';
import { parseStatusMetadata } from './status-file.js';
import type { ServerContext } from './server-types.js';

export function normalizeTaskKind(value: OptionalJsonValue): TaskKind | null {
  return value === 'summary' || value === 'plan' || value === 'repo-search' || value === 'chat'
    ? value
    : null;
}

export function logToolStatsLines(
  requestId: string,
  taskKind: TaskKind,
  stats: Record<string, ToolTypeStats> | null,
): void {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    return;
  }
  for (const [toolType, toolStats] of Object.entries(stats)) {
    const safeToolType = String(toolType || '').trim();
    if (!safeToolType) {
      continue;
    }
    serverLogger.event({
      scope: 'st',
      id: requestId,
      event: 'tool_stats',
      fields: `task=${taskKind} tool=${safeToolType} calls=${Math.max(0, Number(toolStats.calls || 0))}`
        + ` output_chars=${Math.max(0, Number(toolStats.outputCharsTotal || 0))}`
        + ` output_tokens=${Math.max(0, Number(toolStats.outputTokensTotal || 0))}`
        + ` output_tokens_estimated=${Math.max(0, Number(toolStats.outputTokensEstimatedCount || 0))}`,
    });
  }
}

export type DeferredTerminalMetadataJob = {
  requestId: string;
  metadata: ReturnType<typeof parseStatusMetadata>;
  startedAtUtc: string | null;
  finishedAtUtc: string;
  elapsedMs: number | null;
  totalElapsedMs: number | null;
  requestCompleted: boolean;
  suppressLogLine: boolean;
};

export function resolveStatusRunLogIdentity(taskKind: TaskKind | null): {
  runKind: RunLogKind;
  runGroup: RunLogGroup;
  titlePrefix: string;
} {
  if (taskKind === 'summary') {
    return { runKind: 'summary_request', runGroup: 'summary', titlePrefix: 'summary' };
  }
  if (taskKind === 'plan') {
    return { runKind: 'plan', runGroup: 'planner', titlePrefix: 'plan' };
  }
  if (taskKind === 'repo-search') {
    return { runKind: 'repo_search', runGroup: 'repo_search', titlePrefix: 'repo-search' };
  }
  if (taskKind === 'chat') {
    return { runKind: 'chat', runGroup: 'chat', titlePrefix: 'chat' };
  }
  return { runKind: 'unknown', runGroup: 'other', titlePrefix: 'status' };
}

export function persistStatusRunLog(
  ctx: ServerContext,
  job: DeferredTerminalMetadataJob,
  taskKind: TaskKind | null,
): void {
  const terminalState = job.metadata.terminalState;
  if (terminalState !== 'completed' && terminalState !== 'failed') {
    return;
  }
  const identity = resolveStatusRunLogIdentity(taskKind);
  const activePreset = getActiveModelPreset(readConfig(ctx.configPath));
  upsertRunLog(getRuntimeDatabase(), {
    runId: job.requestId,
    requestId: job.requestId,
    runKind: identity.runKind,
    runGroup: identity.runGroup,
    terminalState,
    startedAtUtc: job.startedAtUtc,
    finishedAtUtc: job.finishedAtUtc,
    title: `${identity.titlePrefix} ${job.requestId}`,
    model: activePreset.Model,
    backend: activePreset.Backend,
    repoRoot: null,
    inputTokens: job.metadata.inputTokens,
    outputTokens: job.metadata.totalOutputTokens ?? job.metadata.outputTokens,
    thinkingTokens: job.metadata.thinkingTokens,
    toolTokens: job.metadata.toolTokens,
    promptCacheTokens: job.metadata.promptCacheTokens,
    promptEvalTokens: job.metadata.promptEvalTokens,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    speculativeAcceptedTokens: job.metadata.speculativeAcceptedTokens,
    speculativeGeneratedTokens: job.metadata.speculativeGeneratedTokens,
    durationMs: job.totalElapsedMs ?? job.metadata.requestDurationMs,
    providerDurationMs: job.metadata.providerDurationMs,
    wallDurationMs: job.metadata.wallDurationMs,
    requestJson: null,
    plannerDebugJson: null,
    failedRequestJson: null,
    abandonedRequestJson: null,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: job.finishedAtUtc,
  });
}
