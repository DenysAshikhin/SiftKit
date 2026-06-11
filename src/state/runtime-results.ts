import { randomUUID } from 'node:crypto';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';

export type StoredRuntimeResult = {
  id: string;
  payload: JsonObject;
  createdAtUtc: string;
};

export type RuntimeResultKind = 'benchmark' | 'eval';

function getDatabase(databasePath?: string): RuntimeDatabase {
  return getRuntimeDatabase(databasePath);
}

type RuntimeResultRow = {
  id: string | null;
  payload_json: string | null;
  created_at_utc: string | null;
};

function parsePayload(value: unknown): JsonObject {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    return JsonRecordReader.asObject(JSON.parse(value) as unknown) || {};
  } catch {
    // Ignore malformed payload text.
  }
  return {};
}

function buildResultUri(prefix: 'benchmark-runs' | 'eval-results', id: string): string {
  return `db://${prefix}/${id}`;
}

function parseResultRow(row: RuntimeResultRow | undefined): StoredRuntimeResult | null {
  if (!row || typeof row.id !== 'string') {
    return null;
  }
  return {
    id: row.id,
    payload: parsePayload(row.payload_json),
    createdAtUtc: typeof row.created_at_utc === 'string' ? row.created_at_utc : new Date(0).toISOString(),
  };
}

export function listBenchmarkRuns(options: {
  limit?: number;
  databasePath?: string;
} = {}): StoredRuntimeResult[] {
  const database = getDatabase(options.databasePath);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(Number(options.limit))) : 100;
  const rows = database.prepare(`
    SELECT id, payload_json, created_at_utc
    FROM benchmark_runs
    ORDER BY created_at_utc DESC, id DESC
    LIMIT ?
  `).all(limit) as RuntimeResultRow[];
  return rows.map((row) => parseResultRow(row)).filter((row): row is StoredRuntimeResult => row !== null);
}

export function listEvalResults(options: {
  limit?: number;
  databasePath?: string;
} = {}): StoredRuntimeResult[] {
  const database = getDatabase(options.databasePath);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(Number(options.limit))) : 100;
  const rows = database.prepare(`
    SELECT id, payload_json, created_at_utc
    FROM eval_results
    ORDER BY created_at_utc DESC, id DESC
    LIMIT ?
  `).all(limit) as RuntimeResultRow[];
  return rows.map((row) => parseResultRow(row)).filter((row): row is StoredRuntimeResult => row !== null);
}

export function deleteBenchmarkRun(id: string, databasePath?: string): boolean {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) {
    return false;
  }
  const database = getDatabase(databasePath);
  const result = database.prepare('DELETE FROM benchmark_runs WHERE id = ?').run(normalizedId);
  return Number(result.changes) > 0;
}

export function deleteEvalResult(id: string, databasePath?: string): boolean {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) {
    return false;
  }
  const database = getDatabase(databasePath);
  const result = database.prepare('DELETE FROM eval_results WHERE id = ?').run(normalizedId);
  return Number(result.changes) > 0;
}

export function persistBenchmarkRun(options: {
  id?: string;
  payload: JsonObject;
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
  payload: JsonObject;
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
  `).get(normalizedId) as RuntimeResultRow | undefined;
  return parseResultRow(row);
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
  `).get(normalizedId) as RuntimeResultRow | undefined;
  return parseResultRow(row);
}
