import { randomUUID } from 'node:crypto';
import type { Dict } from '../lib/types.js';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';

export type StoredRuntimeResult = {
  id: string;
  payload: Dict;
  createdAtUtc: string;
};

function getDatabase(databasePath?: string): RuntimeDatabase {
  return getRuntimeDatabase(databasePath);
}

function parsePayload(value: unknown): Dict {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Dict;
    }
  } catch {
    // Ignore malformed payload text.
  }
  return {};
}

function buildResultUri(prefix: 'benchmark-runs' | 'eval-results', id: string): string {
  return `db://${prefix}/${id}`;
}

export function persistBenchmarkRun(options: {
  id?: string;
  payload: Dict;
  databasePath?: string;
}): { id: string; uri: string } {
  const id = String(options.id || '').trim() || randomUUID();
  const database = getDatabase(options.databasePath);
  const nowUtc = new Date().toISOString();
  database.prepare(`
    INSERT INTO benchmark_runs (id, payload_json, created_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json = excluded.payload_json
  `).run(
    id,
    JSON.stringify(options.payload || {}),
    nowUtc,
  );
  return {
    id,
    uri: buildResultUri('benchmark-runs', id),
  };
}

export function persistEvalResult(options: {
  id?: string;
  payload: Dict;
  databasePath?: string;
}): { id: string; uri: string } {
  const id = String(options.id || '').trim() || randomUUID();
  const database = getDatabase(options.databasePath);
  const nowUtc = new Date().toISOString();
  database.prepare(`
    INSERT INTO eval_results (id, payload_json, created_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json = excluded.payload_json
  `).run(
    id,
    JSON.stringify(options.payload || {}),
    nowUtc,
  );
  return {
    id,
    uri: buildResultUri('eval-results', id),
  };
}

export function readBenchmarkRun(id: string, databasePath?: string): StoredRuntimeResult | null {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, payload_json, created_at_utc
    FROM benchmark_runs
    WHERE id = ?
  `).get(normalizedId) as { id?: unknown; payload_json?: unknown; created_at_utc?: unknown } | undefined;
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    payload: parsePayload(row.payload_json),
    createdAtUtc: typeof row.created_at_utc === 'string' ? row.created_at_utc : new Date(0).toISOString(),
  };
}

export function readEvalResult(id: string, databasePath?: string): StoredRuntimeResult | null {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, payload_json, created_at_utc
    FROM eval_results
    WHERE id = ?
  `).get(normalizedId) as { id?: unknown; payload_json?: unknown; created_at_utc?: unknown } | undefined;
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    payload: parsePayload(row.payload_json),
    createdAtUtc: typeof row.created_at_utc === 'string' ? row.created_at_utc : new Date(0).toISOString(),
  };
}
