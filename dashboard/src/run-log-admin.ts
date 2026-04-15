import type {
  RunGroupFilter,
  RunLogDeleteCriteria,
  RunLogDeleteType,
} from './types';

export type RunLogDeleteFormState = {
  mode: 'count' | 'before_date';
  type: RunLogDeleteType;
  countInput: string;
  beforeDate: string;
};

export type RunLogTypePreset = {
  value: RunGroupFilter;
  deleteValue: RunLogDeleteType;
  label: string;
  tone: RunLogDeleteType;
};

export const RUN_LOG_TYPE_PRESETS: RunLogTypePreset[] = [
  { value: '', deleteValue: 'all', label: 'All', tone: 'all' },
  { value: 'summary', deleteValue: 'summary', label: 'Summary', tone: 'summary' },
  { value: 'repo_search', deleteValue: 'repo_search', label: 'Repo Search', tone: 'repo_search' },
  { value: 'planner', deleteValue: 'planner', label: 'Planner', tone: 'planner' },
  { value: 'chat', deleteValue: 'chat', label: 'Chat', tone: 'chat' },
  { value: 'other', deleteValue: 'other', label: 'Other', tone: 'other' },
];

export function normalizeRunLogTypeFilter(value: string): RunGroupFilter {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'summary'
    || normalized === 'repo_search'
    || normalized === 'planner'
    || normalized === 'chat'
    || normalized === 'other') {
    return normalized;
  }
  return '';
}

export function toggleRunLogTypeFilter(current: RunGroupFilter, next: RunGroupFilter): RunGroupFilter {
  return current === next ? '' : next;
}

export function buildRunLogDeleteCriteria(input: RunLogDeleteFormState): RunLogDeleteCriteria | null {
  if (input.mode === 'count') {
    const count = Number(input.countInput);
    if (!Number.isInteger(count) || count < 1) {
      return null;
    }
    return {
      mode: 'count',
      type: input.type,
      count,
    };
  }
  const beforeDate = String(input.beforeDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(beforeDate)) {
    return null;
  }
  return {
    mode: 'before_date',
    type: input.type,
    beforeDate,
  };
}

function getRunLogTypeLabel(type: RunLogDeleteType): string {
  const preset = RUN_LOG_TYPE_PRESETS.find((entry) => entry.deleteValue === type);
  return preset ? preset.label.toLowerCase() : 'log';
}

export function describeRunLogDeleteCriteria(criteria: RunLogDeleteCriteria, matchCount: number): string {
  const countText = `${matchCount} ${matchCount === 1 ? 'log' : 'logs'}`;
  const typeLabel = criteria.type === 'all' ? countText : `${countText.replace(/ logs?$/u, '')} ${getRunLogTypeLabel(criteria.type)} ${matchCount === 1 ? 'log' : 'logs'}`;
  if (criteria.mode === 'count') {
    return `Delete ${typeLabel}`;
  }
  return `Delete ${typeLabel} before ${criteria.beforeDate}`;
}
