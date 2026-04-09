export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getMetricGraphStorageKey(graphId: string): string {
  return `siftkit.dashboard.metric-graph.${graphId}.hidden-series`;
}

export function sanitizeHiddenSeriesState(
  hiddenKeys: Record<string, unknown>,
  validKeys: readonly string[],
): Record<string, true> {
  const validKeySet = new Set(validKeys);
  const sanitized: Record<string, true> = {};
  for (const [key, value] of Object.entries(hiddenKeys)) {
    if (!validKeySet.has(key) || value !== true) {
      continue;
    }
    sanitized[key] = true;
  }
  return sanitized;
}

export function readHiddenSeriesState(
  store: KeyValueStore | null,
  graphId: string,
  validKeys: readonly string[],
): Record<string, true> {
  if (!store) {
    return {};
  }
  try {
    const raw = store.getItem(getMetricGraphStorageKey(graphId));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return sanitizeHiddenSeriesState(parsed, validKeys);
  } catch {
    return {};
  }
}

export function writeHiddenSeriesState(
  store: KeyValueStore | null,
  graphId: string,
  hiddenKeys: Record<string, boolean>,
  validKeys: readonly string[],
): void {
  if (!store) {
    return;
  }
  try {
    const key = getMetricGraphStorageKey(graphId);
    const sanitized = sanitizeHiddenSeriesState(hiddenKeys, validKeys);
    if (Object.keys(sanitized).length === 0) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, JSON.stringify(sanitized));
  } catch {
    // Ignore storage access failures so the graph still renders.
  }
}
