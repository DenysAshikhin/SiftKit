import type { TaskMetricDay, ToolStatsByTask } from './types';

export type ToolMetricRow = {
  toolType: string;
  calls: number;
  outputCharsTotal: number;
  outputTokensTotal: number;
  outputTokensEstimatedCount: number;
  lineReadCalls: number;
  lineReadLinesTotal: number;
  lineReadTokensTotal: number;
  finishRejections: number;
  semanticRepeatRejects: number;
  stagnationWarnings: number;
  forcedFinishFromStagnation: number;
  promptInsertedTokens: number;
  rawToolResultTokens: number;
  newEvidenceCalls: number;
  noNewEvidenceCalls: number;
  lineReadRecommendedLines: number | null;
  lineReadAllowanceTokens: number | null;
};

export type GraphPoint = {
  label: string;
  value: number;
};

export type TaskRunsSeries = {
  key: string;
  title: string;
  color: string;
  points: GraphPoint[];
};

const TASK_KIND_COLORS: Record<string, string> = {
  summary: '#c08947',
  'repo-search': '#42a08f',
  plan: '#8f79d1',
  chat: '#5f95d8',
  other: '#5f6b79',
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  'get-content': 'Reads file contents from disk for code inspection and extraction.',
  'get-childitem': 'Lists files and directories, including recursive project discovery.',
  ls: 'Lists files and directories in a target path.',
  rg: 'Fast recursive text search for symbols, strings, and code patterns.',
  find: 'Finds text patterns in already-opened content.',
  open: 'Opens a URL or fetched source reference for inspection.',
  click: 'Follows a discovered page link by link id.',
  screenshot: 'Captures PDF page images for review.',
  summary: 'Summarizes command output into structured extraction-focused answers.',
  'repo-search': 'Runs repository-aware semantic and keyword code discovery.',
};

function toNumber(value: unknown): number {
  return Number(value || 0);
}

export function sortToolMetricsByCalls<TRow extends ToolMetricRow>(rows: TRow[]): TRow[] {
  return rows.slice().sort((left, right) => {
    if (right.calls !== left.calls) {
      return right.calls - left.calls;
    }
    return left.toolType.localeCompare(right.toolType);
  });
}

export function buildToolMetricRows(toolStats: ToolStatsByTask | null | undefined): ToolMetricRow[] {
  if (!toolStats) {
    return [];
  }
  const byToolType = new Map<string, ToolMetricRow>();
  for (const byType of Object.values(toolStats)) {
    for (const [toolType, stats] of Object.entries(byType || {})) {
      const current = byToolType.get(toolType);
      if (!current) {
        byToolType.set(toolType, {
          toolType,
          calls: toNumber(stats.calls),
          outputCharsTotal: toNumber(stats.outputCharsTotal),
          outputTokensTotal: toNumber(stats.outputTokensTotal),
          outputTokensEstimatedCount: toNumber(stats.outputTokensEstimatedCount),
          lineReadCalls: toNumber(stats.lineReadCalls),
          lineReadLinesTotal: toNumber(stats.lineReadLinesTotal),
          lineReadTokensTotal: toNumber(stats.lineReadTokensTotal),
          finishRejections: toNumber(stats.finishRejections),
          semanticRepeatRejects: toNumber(stats.semanticRepeatRejects),
          stagnationWarnings: toNumber(stats.stagnationWarnings),
          forcedFinishFromStagnation: toNumber(stats.forcedFinishFromStagnation),
          promptInsertedTokens: toNumber(stats.promptInsertedTokens),
          rawToolResultTokens: toNumber(stats.rawToolResultTokens),
          newEvidenceCalls: toNumber(stats.newEvidenceCalls),
          noNewEvidenceCalls: toNumber(stats.noNewEvidenceCalls),
          lineReadRecommendedLines: Number.isFinite(Number(stats.lineReadRecommendedLines))
            ? Number(stats.lineReadRecommendedLines)
            : null,
          lineReadAllowanceTokens: Number.isFinite(Number(stats.lineReadAllowanceTokens))
            ? Number(stats.lineReadAllowanceTokens)
            : null,
        });
        continue;
      }
      current.calls += toNumber(stats.calls);
      current.outputCharsTotal += toNumber(stats.outputCharsTotal);
      current.outputTokensTotal += toNumber(stats.outputTokensTotal);
      current.outputTokensEstimatedCount += toNumber(stats.outputTokensEstimatedCount);
      current.lineReadCalls += toNumber(stats.lineReadCalls);
      current.lineReadLinesTotal += toNumber(stats.lineReadLinesTotal);
      current.lineReadTokensTotal += toNumber(stats.lineReadTokensTotal);
      current.finishRejections += toNumber(stats.finishRejections);
      current.semanticRepeatRejects += toNumber(stats.semanticRepeatRejects);
      current.stagnationWarnings += toNumber(stats.stagnationWarnings);
      current.forcedFinishFromStagnation += toNumber(stats.forcedFinishFromStagnation);
      current.promptInsertedTokens += toNumber(stats.promptInsertedTokens);
      current.rawToolResultTokens += toNumber(stats.rawToolResultTokens);
      current.newEvidenceCalls += toNumber(stats.newEvidenceCalls);
      current.noNewEvidenceCalls += toNumber(stats.noNewEvidenceCalls);
      if (Number.isFinite(Number(stats.lineReadRecommendedLines))) {
        current.lineReadRecommendedLines = Math.max(current.lineReadRecommendedLines ?? 0, Number(stats.lineReadRecommendedLines));
      }
      if (Number.isFinite(Number(stats.lineReadAllowanceTokens))) {
        current.lineReadAllowanceTokens = Math.max(current.lineReadAllowanceTokens ?? 0, Number(stats.lineReadAllowanceTokens));
      }
    }
  }
  return sortToolMetricsByCalls(Array.from(byToolType.values()));
}

export function describeToolType(toolType: string): string {
  const normalized = String(toolType || '').trim().toLowerCase();
  if (!normalized) {
    return 'Tool used during agent execution.';
  }
  return TOOL_DESCRIPTIONS[normalized]
    || `${toolType}: tool call used in agent workflows for discovery or execution.`;
}

export function getGraphHoverIndex(pointCount: number, pointerX: number, width: number): number | null {
  if (pointCount <= 1 || !Number.isFinite(pointerX) || !Number.isFinite(width) || width <= 0) {
    return null;
  }
  if (pointerX < 0 || pointerX > width) {
    return null;
  }
  const ratio = pointerX / width;
  return Math.round(ratio * (pointCount - 1));
}

export function buildTaskRunsSeries(taskMetrics: TaskMetricDay[]): TaskRunsSeries[] {
  const dateSet = new Set<string>();
  for (const entry of taskMetrics) {
    dateSet.add(entry.date);
  }
  const dates = Array.from(dateSet).sort((left, right) => left.localeCompare(right));
  if (dates.length === 0) {
    return [];
  }

  const runsByTaskByDate = new Map<string, Map<string, number>>();
  for (const entry of taskMetrics) {
    const byDate = runsByTaskByDate.get(entry.taskKind) || new Map<string, number>();
    byDate.set(entry.date, Number(entry.runs || 0));
    runsByTaskByDate.set(entry.taskKind, byDate);
  }

  const taskKinds = Array.from(runsByTaskByDate.keys()).sort((left, right) => {
    const leftIndex = ['summary', 'repo-search', 'plan', 'chat'].indexOf(left);
    const rightIndex = ['summary', 'repo-search', 'plan', 'chat'].indexOf(right);
    if (leftIndex !== rightIndex) {
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }
    return left.localeCompare(right);
  });

  return taskKinds.map((taskKind) => {
    const byDate = runsByTaskByDate.get(taskKind) || new Map<string, number>();
    const color = TASK_KIND_COLORS[taskKind] || '#5f6b79';
    return {
      key: `runs-${taskKind}`,
      title: taskKind === 'repo-search'
        ? 'Repo Search'
        : taskKind === 'plan'
          ? 'Plan'
          : taskKind === 'summary'
            ? 'Summary'
            : taskKind === 'chat'
              ? 'Chat'
              : taskKind,
      color,
      points: dates.map((date) => ({ label: date, value: byDate.get(date) || 0 })),
    };
  });
}
