import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { readChatRunMessages } from '../../src/state/chat-sessions.js';
import { rebuildChatRun } from '../../src/status-server/chat-run-projection.js';
import { openSessionDatabase, beginProposedRun, committedKinds, CALL, AT, assertPrefixIntact, SESSION_ID, assertStorageFailureIsFatal } from '../helpers/chat-recovery-storage-faults-fixtures.js';

test('SQLITE_BUSY on a tool start commits nothing, keeps the published prefix, and closes the run as a storage failure', () => {
  const { database, databasePath } = openSessionDatabase('chat-storage-busy-');
  const recorder = beginProposedRun(databasePath);
  const prefix = committedKinds(database, recorder.operationId);
  assert.deepEqual(prefix, ['run_started', 'engine_bound', 'context_initialized', 'display', 'tool_proposed']);

  // A second connection holds the write lock; the recorder must fail rather than wait forever.
  const blocker = new Database(databasePath, { timeout: 50 });
  blocker.exec('BEGIN IMMEDIATE');
  database.pragma('busy_timeout = 50');
  try {
    assert.throws(() => recorder.recordToolStarted({ call: CALL, startedAtUtc: AT }), { code: 'SQLITE_BUSY' });
    assertPrefixIntact(database, recorder.operationId, prefix);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
    database.pragma('busy_timeout = 5000');
  }

  // Nothing was authorized while blocked: the proposal is still not started after rebuild.
  rebuildChatRun(database, recorder.operationId);
  const rows = readChatRunMessages(database, SESSION_ID, recorder.operationId);
  assert.equal(rows.find(message => message.kind === 'assistant_tool_call')?.toolCallExecutionState, 'proposed');
  assert.equal(rows.find(message => message.kind === 'assistant_progress')?.content, 'Published before the fault. ');

  assertStorageFailureIsFatal(database, recorder, prefix, 'SQLITE_BUSY');
});
