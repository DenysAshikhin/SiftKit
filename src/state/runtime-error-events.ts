import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { toError } from '../lib/errors.js';
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
  error: Error;
};

export function createRuntimeErrorEventId(): string {
  return crypto.randomUUID();
}

export function insertRuntimeErrorEvent(database: DatabaseInstance, input: RuntimeErrorEventInput): string {
  const id = input.id?.trim() || createRuntimeErrorEventId();
  const diagnostic: ErrorDiagnostic = serializeErrorDiagnostic(toError(input.error));
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
