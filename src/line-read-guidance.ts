import * as fs from 'node:fs';
import Database from 'better-sqlite3';

import type { SiftConfig } from './config/index.js';
import { getConfiguredLlamaNumCtx } from './config/index.js';
import { getIdleSummarySnapshotsPath } from './config/paths.js';
import { getPlannerPromptBudget } from './summary/chunking.js';
import type { ToolTypeStats } from './status-server/metrics.js';

const THINKING_BUFFER_RATIO = 0.15;
const THINKING_BUFFER_MIN_TOKENS = 4000;
const REPO_SEARCH_PER_TOOL_RATIO = 0.10;
const PLANNER_RESULT_RATIO = 0.70;
const LINE_READ_TARGET_RATIO = 0.50;

type DatabaseInstance = InstanceType<typeof Database>;

export type LineReadGuidance = {
  avgTokensPerLine: number;
  perToolAllowanceTokens: number;
  recommendedLines: number;
};

export function createEmptyToolTypeStats(): ToolTypeStats {
  return {
    calls: 0,
    outputCharsTotal: 0,
    outputTokensTotal: 0,
    outputTokensEstimatedCount: 0,
    lineReadCalls: 0,
    lineReadLinesTotal: 0,
    lineReadTokensTotal: 0,
  };
}

export function mergeToolTypeStats(
  previous: Record<string, ToolTypeStats> | null | undefined,
  update: Record<string, ToolTypeStats> | null | undefined,
): Record<string, ToolTypeStats> {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return previous ? { ...previous } : {};
  }
  const merged: Record<string, ToolTypeStats> = previous ? { ...previous } : {};
  for (const [toolTypeRaw, rawStats] of Object.entries(update)) {
    const toolType = String(toolTypeRaw || '').trim();
    if (!toolType || !rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) {
      continue;
    }
    const stats = rawStats as Partial<ToolTypeStats>;
    const current = merged[toolType] || createEmptyToolTypeStats();
    merged[toolType] = {
      calls: current.calls + (Number.isFinite(stats.calls) ? Number(stats.calls) : 0),
      outputCharsTotal: current.outputCharsTotal + (Number.isFinite(stats.outputCharsTotal) ? Number(stats.outputCharsTotal) : 0),
      outputTokensTotal: current.outputTokensTotal + (Number.isFinite(stats.outputTokensTotal) ? Number(stats.outputTokensTotal) : 0),
      outputTokensEstimatedCount: current.outputTokensEstimatedCount + (
        Number.isFinite(stats.outputTokensEstimatedCount) ? Number(stats.outputTokensEstimatedCount) : 0
      ),
      lineReadCalls: current.lineReadCalls + (Number.isFinite(stats.lineReadCalls) ? Number(stats.lineReadCalls) : 0),
      lineReadLinesTotal: current.lineReadLinesTotal + (Number.isFinite(stats.lineReadLinesTotal) ? Number(stats.lineReadLinesTotal) : 0),
      lineReadTokensTotal: current.lineReadTokensTotal + (Number.isFinite(stats.lineReadTokensTotal) ? Number(stats.lineReadTokensTotal) : 0),
    };
  }
  return merged;
}

export function aggregateGlobalToolStats(
  byTask: Record<string, Record<string, ToolTypeStats>> | null | undefined,
): Record<string, ToolTypeStats> {
  if (!byTask || typeof byTask !== 'object' || Array.isArray(byTask)) {
    return {};
  }
  let aggregated: Record<string, ToolTypeStats> = {};
  for (const taskStats of Object.values(byTask)) {
    aggregated = mergeToolTypeStats(aggregated, taskStats);
  }
  return aggregated;
}

export function countExtractedLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.replace(/\r\n/gu, '\n').split('\n').length;
}

function isLineBoundGetContentCommand(command: string): boolean {
  const normalized = String(command || '').trim().toLowerCase();
  if (!/^get-content\b/u.test(normalized)) {
    return false;
  }
  if (/(?:^|\s)-totalcount\b/u.test(normalized)) {
    return true;
  }
  if (!/\|\s*select-object\b/u.test(normalized)) {
    return false;
  }
  return /(?:^|\s)-(first|last)\b/u.test(normalized);
}

export function getRepoSearchLineReadStats(
  command: string,
  outputText: string,
  rawTokenCount: number,
): Partial<ToolTypeStats> | null {
  if (!isLineBoundGetContentCommand(command)) {
    return null;
  }
  const lineCount = countExtractedLines(String(outputText || ''));
  if (lineCount <= 0 || !Number.isFinite(rawTokenCount) || Number(rawTokenCount) <= 0) {
    return null;
  }
  return {
    lineReadCalls: 1,
    lineReadLinesTotal: lineCount,
    lineReadTokensTotal: Math.max(0, Math.ceil(Number(rawTokenCount))),
  };
}

export function buildLineReadGuidance(options: {
  toolName: string;
  toolStats: Record<string, ToolTypeStats> | null | undefined;
  perToolAllowanceTokens: number | null | undefined;
}): LineReadGuidance | null {
  const stats = options.toolStats?.[options.toolName];
  const allowance = Number(options.perToolAllowanceTokens);
  if (!stats || !Number.isFinite(allowance) || allowance <= 0) {
    return null;
  }
  if (
    !Number.isFinite(stats.lineReadCalls) || Number(stats.lineReadCalls) <= 0
    || !Number.isFinite(stats.lineReadLinesTotal) || Number(stats.lineReadLinesTotal) <= 0
    || !Number.isFinite(stats.lineReadTokensTotal) || Number(stats.lineReadTokensTotal) <= 0
  ) {
    return null;
  }
  const avgTokensPerLine = Number(stats.lineReadTokensTotal) / Number(stats.lineReadLinesTotal);
  if (!Number.isFinite(avgTokensPerLine) || avgTokensPerLine <= 0) {
    return null;
  }
  return {
    avgTokensPerLine,
    perToolAllowanceTokens: Math.max(1, Math.floor(allowance)),
    recommendedLines: Math.max(1, Math.floor((allowance * LINE_READ_TARGET_RATIO) / avgTokensPerLine)),
  };
}

export function getRepoSearchPromptBaselinePerToolAllowanceTokens(config?: SiftConfig | null): number {
  const totalContextTokens = Math.max(1, Number(config ? getConfiguredLlamaNumCtx(config) : 32000));
  const thinkingBufferTokens = Math.max(Math.ceil(totalContextTokens * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS);
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  return Math.max(1, Math.floor(usablePromptTokens * REPO_SEARCH_PER_TOOL_RATIO));
}

export function getPlannerPromptBaselinePerToolAllowanceTokens(config: SiftConfig): number {
  return Math.max(1, Math.floor(getPlannerPromptBudget(config).plannerStopLineTokens * PLANNER_RESULT_RATIO));
}

function readLatestSnapshotToolStatsFromDatabase(database: DatabaseInstance): Record<string, ToolTypeStats> {
  const row = database
    .prepare('SELECT tool_stats_json FROM idle_summary_snapshots ORDER BY id DESC LIMIT 1')
    .get() as { tool_stats_json?: unknown } | undefined;
  if (!row || typeof row.tool_stats_json !== 'string' || !row.tool_stats_json.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(row.tool_stats_json) as Record<string, Record<string, ToolTypeStats>>;
    return aggregateGlobalToolStats(parsed);
  } catch {
    return {};
  }
}

export function readLatestIdleSummaryToolStats(
  snapshotPath: string = getIdleSummarySnapshotsPath(),
): Record<string, ToolTypeStats> {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return {};
  }
  let database: DatabaseInstance | null = null;
  try {
    database = new Database(snapshotPath, { readonly: true });
    return readLatestSnapshotToolStatsFromDatabase(database);
  } catch {
    return {};
  } finally {
    if (database) {
      database.close();
    }
  }
}
