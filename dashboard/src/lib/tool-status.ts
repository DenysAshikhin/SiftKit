import type { ToolActivityKind } from '../types';

export type ToolActivityLifecycle = 'running' | 'completed' | 'failed';

function extractFetchHost(command: string): string | null {
  const match = /url="([^"]+)"/u.exec(command);
  const url = match?.[1];
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function selectLifecycleLabel(
  lifecycle: ToolActivityLifecycle,
  running: string,
  completed: string,
  failed: string,
): string {
  if (lifecycle === 'running') return running;
  if (lifecycle === 'completed') return completed;
  return failed;
}

export function getToolActivityLabel(
  activityKind: ToolActivityKind,
  lifecycle: ToolActivityLifecycle,
  command: string,
): string {
  switch (activityKind) {
    case 'read':
      return selectLifecycleLabel(lifecycle, 'Reading files\u2026', 'Read files', 'File read failed');
    case 'search':
      return selectLifecycleLabel(lifecycle, 'Searching code\u2026', 'Searched code', 'Search failed');
    case 'edit':
      return selectLifecycleLabel(lifecycle, 'Editing files\u2026', 'Edited files', 'File edit failed');
    case 'validate':
      return selectLifecycleLabel(lifecycle, 'Validating project\u2026', 'Validation complete', 'Validation failed');
    case 'web_search':
      return selectLifecycleLabel(lifecycle, 'Fetching search results\u2026', 'Search complete', 'Search failed');
    case 'web_fetch': {
      const host = extractFetchHost(command);
      return selectLifecycleLabel(
        lifecycle,
        host ? `Loading ${host}\u2026` : 'Loading page\u2026',
        host ? `${host} loaded` : 'Page loaded',
        'Page load failed',
      );
    }
    case 'command':
      return selectLifecycleLabel(lifecycle, 'Running command\u2026', 'Command complete', 'Command failed');
  }
}
