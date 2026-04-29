import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  StatusServerUnavailableError,
  getStatusServerHealthUrl,
} from '../dist/config/index.js';
import {
  serializeErrorDiagnostic,
  getPrimaryCauseDiagnostic,
} from '../dist/lib/error-diagnostics.js';
import {
  insertRuntimeErrorEvent,
  ensureRuntimeErrorEventsTable,
} from '../dist/state/runtime-error-events.js';
import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../dist/state/runtime-db.js';

test('StatusServerUnavailableError preserves diagnostic cause and service context', () => {
  const cause = new Error('Request timed out after 130000 ms.');
  const error = new StatusServerUnavailableError('http://127.0.0.1:4765/health', {
    cause,
    operation: 'config:get',
    serviceUrl: 'http://127.0.0.1:4765/config',
  });

  assert.equal(error.name, 'StatusServerUnavailableError');
  assert.equal(error.healthUrl, 'http://127.0.0.1:4765/health');
  assert.equal(error.operation, 'config:get');
  assert.equal(error.serviceUrl, 'http://127.0.0.1:4765/config');
  assert.equal(error.cause, cause);
  assert.match(error.message, /not reachable/u);
});

test('serializeErrorDiagnostic includes nested causes, stack, and custom status context', () => {
  const root = new Error('socket hang up');
  const wrapped = new StatusServerUnavailableError('http://127.0.0.1:4765/health', {
    cause: root,
    operation: 'execution:acquire',
    serviceUrl: 'http://127.0.0.1:4765/execution/acquire',
  });

  const diagnostic = serializeErrorDiagnostic(wrapped);
  const primaryCause = getPrimaryCauseDiagnostic(diagnostic);

  assert.equal(diagnostic.name, 'StatusServerUnavailableError');
  assert.equal(diagnostic.operation, 'execution:acquire');
  assert.equal(diagnostic.serviceUrl, 'http://127.0.0.1:4765/execution/acquire');
  assert.equal(diagnostic.healthUrl, getStatusServerHealthUrl());
  assert.equal(typeof diagnostic.stack, 'string');
  assert.equal(diagnostic.cause?.name, 'Error');
  assert.equal(diagnostic.cause?.message, 'socket hang up');
  assert.equal(primaryCause?.message, 'socket hang up');
});

test('runtime error events schema stores serialized diagnostics', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-error-events-'));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'siftkit' }), 'utf8');
    process.chdir(tempRoot);
    const database = getRuntimeDatabase();
    ensureRuntimeErrorEventsTable(database);
    const cause = new Error('Request timed out after 130000 ms.');
    const error = new StatusServerUnavailableError('http://127.0.0.1:4765/health', {
      cause,
      operation: 'config:get',
      serviceUrl: 'http://127.0.0.1:4765/config',
    });

    const diagnosticId = insertRuntimeErrorEvent(database, {
      source: 'status-server',
      route: '/summary',
      method: 'POST',
      requestId: 'req-1',
      taskKind: 'summary',
      statusCode: 500,
      error,
    });

    const row = database.prepare(`
      SELECT id, source, route, method, request_id, task_kind, status_code,
             error_name, error_message, cause_name, cause_message, diagnostic_json
      FROM runtime_error_events
      WHERE id = ?
    `).get(diagnosticId) as Record<string, unknown> | undefined;

    assert.equal(row?.source, 'status-server');
    assert.equal(row?.route, '/summary');
    assert.equal(row?.method, 'POST');
    assert.equal(row?.request_id, 'req-1');
    assert.equal(row?.task_kind, 'summary');
    assert.equal(row?.status_code, 500);
    assert.equal(row?.error_name, 'StatusServerUnavailableError');
    assert.equal(row?.cause_name, 'Error');
    assert.equal(row?.cause_message, 'Request timed out after 130000 ms.');
    assert.match(String(row?.diagnostic_json), /"operation":"config:get"/u);
  } finally {
    closeRuntimeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
