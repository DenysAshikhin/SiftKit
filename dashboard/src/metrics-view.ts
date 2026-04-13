import type { TaskMetricDay } from './types';

export type ToolMetricRow = {
  taskKind: string;
  toolType: string;
  calls: number;
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

const TASK_KIND_ORDER = ['summary', 'repo-search', 'plan', 'chat'] as const;

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

function taskKindSortIndex(taskKind: string): number {
  const index = TASK_KIND_ORDER.indexOf(taskKind as (typeof TASK_KIND_ORDER)[number]);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function sortToolMetricsByCalls<TRow extends ToolMetricRow>(rows: TRow[]): TRow[] {
  return rows.slice().sort((left, right) => {
    if (right.calls !== left.calls) {
      return right.calls - left.calls;
    }
    const leftIndex = taskKindSortIndex(left.taskKind);
    const rightIndex = taskKindSortIndex(right.taskKind);
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    const taskCompare = left.taskKind.localeCompare(right.taskKind);
    if (taskCompare !== 0) {
      return taskCompare;
    }
    return left.toolType.localeCompare(right.toolType);
  });
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
    const leftIndex = taskKindSortIndex(left);
    const rightIndex = taskKindSortIndex(right);
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
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
