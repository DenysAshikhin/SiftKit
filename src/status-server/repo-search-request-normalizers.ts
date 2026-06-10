import type { RepoSearchMockCommandResult } from '../repo-search/types.js';

function normalizeOptionalNumber(value: unknown): number | undefined {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function normalizeRepoSearchMockCommandResults(
  value: unknown,
): Record<string, RepoSearchMockCommandResult> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, RepoSearchMockCommandResult> = {};
  for (const [command, rawResult] of Object.entries(value as Record<string, unknown>)) {
    if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
      continue;
    }
    const record = rawResult as Record<string, unknown>;
    result[command] = {
      exitCode: normalizeOptionalNumber(record.exitCode),
      stdout: normalizeOptionalString(record.stdout),
      stderr: normalizeOptionalString(record.stderr),
      delayMs: normalizeOptionalNumber(record.delayMs),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
