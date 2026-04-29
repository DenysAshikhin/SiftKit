import * as http from 'node:http';
import { getPrimaryCauseDiagnostic, serializeErrorDiagnostic } from '../lib/error-diagnostics.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import {
  createRuntimeErrorEventId,
  insertRuntimeErrorEvent,
} from '../state/runtime-error-events.js';
import { sendJson } from './http-utils.js';

export type ServerErrorResponseOptions = {
  taskKind?: string | null;
  requestId?: string | null;
};

function normalizeLogValue(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function getRequestRoute(req: http.IncomingMessage): string {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return req.url || '/';
  }
}

export function sendServerErrorJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  statusCode: number,
  error: unknown,
  options: ServerErrorResponseOptions = {},
): void {
  const diagnosticId = createRuntimeErrorEventId();
  const diagnostic = serializeErrorDiagnostic(error);
  const cause = getPrimaryCauseDiagnostic(diagnostic);
  const route = getRequestRoute(req);
  const method = req.method || 'GET';
  const errorMessage = diagnostic.message;
  process.stderr.write(
    `[siftKitStatus] request_error diagnostic_id=${diagnosticId}`
    + ` method=${normalizeLogValue(method)} route=${normalizeLogValue(route)} status_code=${statusCode}`
    + ` error_name=${normalizeLogValue(diagnostic.name)} error_message=${normalizeLogValue(errorMessage)}`
    + ` cause_name=${normalizeLogValue(cause?.name)} cause_message=${normalizeLogValue(cause?.message)}\n`,
  );
  if (diagnostic.stack) {
    process.stderr.write(`${diagnostic.stack}\n`);
  }
  if (cause?.stack) {
    process.stderr.write(`Caused by: ${cause.stack}\n`);
  }
  try {
    insertRuntimeErrorEvent(getRuntimeDatabase(), {
      id: diagnosticId,
      source: 'status-server',
      route,
      method,
      requestId: options.requestId ?? null,
      taskKind: options.taskKind ?? null,
      statusCode,
      error,
    });
  } catch (dbError) {
    const dbMessage = dbError instanceof Error ? dbError.message : String(dbError);
    process.stderr.write(
      `[siftKitStatus] request_error_db_write_failed diagnostic_id=${diagnosticId}`
      + ` error=${normalizeLogValue(dbMessage)}\n`,
    );
  }
  sendJson(res, statusCode, {
    error: errorMessage,
    errorName: diagnostic.name,
    diagnosticId,
    diagnostic,
  });
}
