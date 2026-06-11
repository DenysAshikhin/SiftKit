import { JsonRecordReader } from '../lib/json-record-reader.js';
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
  for (const [command, rawResult] of Object.entries(JsonRecordReader.asObject(value) || {})) {
    const record = JsonRecordReader.asObject(rawResult);
    if (!record) {
      continue;
    }
    const reader = new JsonRecordReader(record);
    result[command] = {
      exitCode: normalizeOptionalNumber(reader.value('exitCode')),
      stdout: normalizeOptionalString(reader.value('stdout')),
      stderr: normalizeOptionalString(reader.value('stderr')),
      delayMs: normalizeOptionalNumber(reader.value('delayMs')),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
