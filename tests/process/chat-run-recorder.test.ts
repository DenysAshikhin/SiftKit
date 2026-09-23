import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

import { ChatRuntimeOwner } from '../../src/state/chat-runtime-owner.js';
import { createInferenceRun, readInferenceRunLogTextByStream } from '../../src/state/inference-runs.js';
import { openSessionDatabase, beginRecorder, readAll, AT } from '../helpers/chat-run-recorder-fixtures.js';

/** The flush worker's write as a second connection: its own handle, its own short busy wait. */
function openLogWriter(databasePath: string): { write(runId: string, text: string): void; close(): void } {
  const connection = new Database(databasePath);
  connection.exec('PRAGMA busy_timeout = 1;');
  const insert = connection.prepare(`
    INSERT INTO inference_run_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc)
    VALUES (?, 'launcher_stdout', (SELECT COALESCE(MAX(sequence), -1) + 1 FROM inference_run_log_chunks WHERE run_id = ?), ?, ?)
  `);
  return {
    write: (runId, text) => { connection.transaction(() => { insert.run(runId, runId, text, AT); }).immediate(); },
    close: () => connection.close(),
  };
}

// Chat first. The journal reads the run row and then inserts; a log batch that lands between the
// two would invalidate a deferred snapshot (SQLITE_BUSY_SNAPSHOT) after the run state was read.
// Reserving the writer before the read makes the log writer yield instead, and its retry lands once.
test('the journal reserves the writer before reading, so a competing log write yields and retries once', (t) => {
  const { database, databasePath } = openSessionDatabase('chat-journal-writer-race-');
  const recorder = beginRecorder(databasePath);
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup', databasePath });
  const logWriter = openLogWriter(databasePath);
  const prepare = database.prepare.bind(database);
  const competingCodes: string[] = [];
  t.mock.method(database, 'prepare', (sql: string) => {
    if (competingCodes.length === 0 && sql.includes('INSERT INTO chat_run_events')) {
      try { logWriter.write(run.id, 'during\n'); competingCodes.push('committed'); } catch (error) { competingCodes.push(error instanceof Database.SqliteError ? error.code : String(error)); }
    }
    return prepare(sql);
  });
  try {
    recorder.recordPresentation({ kind: 'warning', warning: 'status' });
    assert.deepEqual(competingCodes, ['SQLITE_BUSY']);
    logWriter.write(run.id, 'during\n');
  } finally {
    logWriter.close();
  }
  assert.equal(readAll(database, recorder.operationId).filter(envelope => envelope.event.kind === 'presentation').length, 1);
  assert.equal(readInferenceRunLogTextByStream(run.id, databasePath).launcher_stdout, 'during\n');
  assert.equal(recorder.terminalCause, null);
});

// Log writer first. It holds the writer for a while on another thread; the journal waits its
// bounded SQLite wait for the slot rather than reading under a snapshot it cannot commit.
test('the journal waits for a log batch that already holds the writer and then commits', async () => {
  const { database, databasePath } = openSessionDatabase('chat-journal-writer-wait-');
  const recorder = beginRecorder(databasePath);
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup', databasePath });
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const connection = new Database(workerData.databasePath);
    connection.transaction(() => {
      connection.prepare("INSERT INTO inference_run_log_chunks (run_id, stream_kind, sequence, chunk_text, created_at_utc) VALUES (?, 'launcher_stdout', 0, ?, ?)")
        .run(workerData.runId, 'held\\n', workerData.at);
      parentPort.postMessage('holding');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
    }).immediate();
    connection.close();
    parentPort.postMessage('released');
  `, { eval: true, workerData: { databasePath, runId: run.id, at: AT, holdMs: 300 } });
  const messages: string[] = [];
  const released = new Promise<void>((resolve, reject) => {
    worker.on('message', (message: string) => { messages.push(message); if (message === 'released') resolve(); });
    worker.on('error', reject);
  });
  await new Promise<void>((resolve) => worker.once('message', () => resolve()));
  const startedAt = Date.now();
  recorder.recordPresentation({ kind: 'warning', warning: 'status' });
  const waitedMs = Date.now() - startedAt;
  await released;
  assert.deepEqual(messages, ['holding', 'released']);
  assert.ok(waitedMs >= 200, `journal waited ${waitedMs}ms for the held writer`);
  assert.equal(readAll(database, recorder.operationId).filter(envelope => envelope.event.kind === 'presentation').length, 1);
  assert.equal(readInferenceRunLogTextByStream(run.id, databasePath).launcher_stdout, 'held\n');
});

// Owner heartbeat and nested recorder transactions go through the same reservation: an inner
// immediate transaction is a savepoint, so the outer boundary is the one that reserves.
test('owner renewal and nested recorder writes commit against a competing log writer', (t) => {
  const { database, databasePath } = openSessionDatabase('chat-journal-nested-race-');
  const owner = ChatRuntimeOwner.acquire(database, 'owner-a');
  const recorder = beginRecorder(databasePath);
  const run = createInferenceRun({ backend: 'exl3', purpose: 'startup', databasePath });
  const logWriter = openLogWriter(databasePath);
  const prepare = database.prepare.bind(database);
  const competingCodes: string[] = [];
  t.mock.method(database, 'prepare', (sql: string) => {
    if (sql.includes('INSERT INTO chat_run_events') || sql.includes('UPDATE chat_runtime_owner')) {
      try { logWriter.write(run.id, 'x'); } catch (error) { competingCodes.push(error instanceof Database.SqliteError ? error.code : String(error)); }
    }
    return prepare(sql);
  });
  try {
    owner.renew();
    recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  } finally {
    logWriter.close();
  }
  assert.deepEqual(competingCodes, ['SQLITE_BUSY', 'SQLITE_BUSY']);
  assert.equal(readAll(database, recorder.operationId).filter(envelope => envelope.event.kind === 'run_finished').length, 1);
  assert.equal(recorder.terminalCause, 'completed');
  assert.equal(readInferenceRunLogTextByStream(run.id, databasePath).launcher_stdout, '');
});
