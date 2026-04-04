export const MAX_JSON_FALLBACK_PREVIEW_CHARACTERS = 200;

export function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getFiniteInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function getValueByPath(value: unknown, pathText: string): unknown {
  if (!pathText.trim()) {
    return value;
  }

  const segments = pathText.split('.').map((segment) => segment.trim()).filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function setValueByPath(
  target: Record<string, unknown>,
  pathText: string,
  value: unknown
): void {
  const segments = pathText.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    return;
  }

  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = getRecord(current[segment]);
    if (next) {
      current = next;
      continue;
    }

    current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]] = value;
}

export function normalizeJsonFilterFilters(
  filters: Record<string, unknown>[]
): Record<string, unknown>[] {
  const normalized: Record<string, unknown>[] = [];

  for (const filter of filters) {
    const pathText = typeof filter.path === 'string' ? filter.path : '';
    const op = typeof filter.op === 'string' ? filter.op : '';
    const nestedBounds = getRecord(filter.value);
    const nestedEntries = nestedBounds
      ? Object.entries(nestedBounds).filter((entry) => ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(entry[0]))
      : [];
    if (pathText && op && nestedEntries.length > 0) {
      for (const [nestedOp, nestedValue] of nestedEntries) {
        normalized.push({
          path: pathText,
          op: nestedOp,
          value: nestedValue,
        });
      }
      continue;
    }

    normalized.push(filter);
  }

  return normalized;
}

export function compareJsonFilterOrdered(
  actual: unknown,
  expected: unknown,
  op: 'gt' | 'gte' | 'lt' | 'lte'
): boolean {
  if (getRecord(expected) || Array.isArray(expected)) {
    throw new Error(`json_filter ${op} requires a scalar value.`);
  }

  if (typeof actual === 'string' && typeof expected === 'string') {
    switch (op) {
      case 'gt':
        return actual > expected;
      case 'gte':
        return actual >= expected;
      case 'lt':
        return actual < expected;
      case 'lte':
        return actual <= expected;
      default:
        return false;
    }
  }

  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) {
    return false;
  }

  switch (op) {
    case 'gt':
      return actualNumber > expectedNumber;
    case 'gte':
      return actualNumber >= expectedNumber;
    case 'lt':
      return actualNumber < expectedNumber;
    case 'lte':
      return actualNumber <= expectedNumber;
    default:
      return false;
  }
}

export function matchesJsonFilter(item: unknown, filter: Record<string, unknown>): boolean {
  const pathText = typeof filter.path === 'string' ? filter.path : '';
  const op = typeof filter.op === 'string' ? filter.op : '';
  const expected = filter.value;
  const actual = getValueByPath(item, pathText);

  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return compareJsonFilterOrdered(actual, expected, 'gt');
    case 'gte':
      return compareJsonFilterOrdered(actual, expected, 'gte');
    case 'lt':
      return compareJsonFilterOrdered(actual, expected, 'lt');
    case 'lte':
      return compareJsonFilterOrdered(actual, expected, 'lte');
    case 'contains':
      return Array.isArray(actual)
        ? actual.includes(expected)
        : String(actual ?? '').includes(String(expected ?? ''));
    case 'exists':
      return expected === false ? actual === undefined : actual !== undefined;
    default:
      throw new Error(`Unsupported json_filter op: ${op}`);
  }
}

export function projectJsonFilterItem(item: unknown, select: string[] | null): unknown {
  if (!select || select.length === 0) {
    return item;
  }

  const projected: Record<string, unknown> = {};
  for (const pathText of select) {
    setValueByPath(projected, pathText, getValueByPath(item, pathText));
  }
  return projected;
}

export function toJsonFallbackPreview(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= MAX_JSON_FALLBACK_PREVIEW_CHARACTERS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_JSON_FALLBACK_PREVIEW_CHARACTERS)}...`;
}

export function findBalancedJsonEndIndex(inputText: string, startIndex: number): number {
  const startChar = inputText[startIndex];
  if (startChar !== '{' && startChar !== '[') {
    return -1;
  }

  let stackDepth = 0;
  let inString = false;
  let escaping = false;
  for (let index = startIndex; index < inputText.length; index += 1) {
    const char = inputText[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stackDepth += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      stackDepth -= 1;
      if (stackDepth === 0) {
        return index + 1;
      }
      if (stackDepth < 0) {
        return -1;
      }
    }
  }

  return -1;
}

export function parseJsonForJsonFilter(inputText: string): {
  parsed: unknown;
  usedFallback: boolean;
  ignoredPrefixPreview: string | null;
  parsedSectionPreview: string | null;
} {
  try {
    return {
      parsed: JSON.parse(inputText) as unknown,
      usedFallback: false,
      ignoredPrefixPreview: null,
      parsedSectionPreview: null,
    };
  } catch {
    // Fall through to embedded JSON scan.
  }

  const candidatePattern = /[\[{]/gu;
  for (const match of inputText.matchAll(candidatePattern)) {
    const startIndex = typeof match.index === 'number' ? match.index : -1;
    if (startIndex < 0) {
      continue;
    }
    const endIndex = findBalancedJsonEndIndex(inputText, startIndex);
    if (endIndex <= startIndex) {
      continue;
    }

    const candidate = inputText.slice(startIndex, endIndex);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return {
        parsed,
        usedFallback: true,
        ignoredPrefixPreview: toJsonFallbackPreview(inputText.slice(0, startIndex)),
        parsedSectionPreview: toJsonFallbackPreview(candidate),
      };
    } catch {
      // Continue scanning for first valid JSON section.
    }
  }

  throw new Error('json_filter input is not valid JSON to parse.');
}
