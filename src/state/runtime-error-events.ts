import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
  getPrimaryCauseDiagnostic,
  serializeErrorDiagnostic,
  type ErrorDiagnostic,
} from '../lib/error-diagnostics.js';

type DatabaseInstance = InstanceType<typeof Database>;

export type RuntimeErrorEventInput = {
  id?: string;
  source: string;
  route: string;
  method: string;
  requestId?: string | null;
  taskKind?: string | null;
  statusCode: number;
  error: unknown;
};

export function createRuntimeErrorEventId(): string {
  return crypto.randomUUID();
}

export function ensureRuntimeErrorEventsTable(database: DatabaseInstance): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_error_events (
      id TEXT PRIMARY KEY,
      created_at_utc TEXT NOT NULL,
      source TEXT NOT NULL,
      route TEXT NOT NULL,
      method TEXT NOT NULL,
      request_id TEXT,
      task_kind TEXT,
      status_code INTEGER NOT NULL,
      error_name TEXT NOT NULL,
      error_message TEXT NOT NULL,
      error_stack TEXT,
      cause_name TEXT,
      cause_message TEXT,
      cause_stack TEXT,
      diagnostic_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_error_events_created
      ON runtime_error_events(created_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_error_events_route_created
      ON runtime_error_events(route, created_at_utc DESC);
  `);
}

export function insertRuntimeErrorEvent(database: DatabaseInstance, input: RuntimeErrorEventInput): string {
  ensureRuntimeErrorEventsTable(database);
  const id = input.id?.trim() || createRuntimeErrorEventId();
  const diagnostic: ErrorDiagnostic = serializeErrorDiagnostic(input.error);
  const cause = getPrimaryCauseDiagnostic(diagnostic);
  database.prepare(`
    INSERT INTO runtime_error_events (
      id, created_at_utc, source, route, method, request_id, task_kind, status_code,
      error_name, error_message, error_stack, cause_name, cause_message, cause_stack,
      diagnostic_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date().toISOString(),
    input.source,
    input.route,
    input.method,
    input.requestId ?? null,
    input.taskKind ?? null,
    input.statusCode,
    diagnostic.name,
    diagnostic.message,
    diagnostic.stack ?? null,
    cause?.name ?? null,
    cause?.message ?? null,
    cause?.stack ?? null,
    JSON.stringify(diagnostic),
  );
  return id;
}
