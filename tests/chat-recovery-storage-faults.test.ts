import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { readChatRunMessages } from '../src/state/chat-sessions.js';
import { rebuildChatRun } from '../src/status-server/chat-run-projection.js';
import { openSessionDatabase, beginProposedRun, committedKinds, CALL, AT, assertPrefixIntact, SESSION_ID, assertStorageFailureIsFatal } from './helpers/chat-recovery-storage-faults-fixtures.js';

test('SQLITE_FULL on a tool result commits nothing and closes the run as a storage failure', () => {
  const { database, databasePath } = openSessionDatabase('chat-storage-full-');
  const recorder = beginProposedRun(databasePath);
  recorder.recordToolStarted({ call: CALL, startedAtUtc: AT });
  const prefix = committedKinds(database, recorder.operationId);

  // Cap the file, never the disk: a result larger than the remaining pages must fail as SQLITE_FULL.
  const pageCount = z.number().int().positive().parse(database.pragma('page_count', { simple: true }));
  database.pragma(`max_page_count = ${String(pageCount + 2)}`);
  const output = 'x'.repeat(512 * 1024);
  const result = { call: CALL, executionState: 'completed' as const, exitCode: 0, output, images: [], imageMeta: [],
    outputTokens: 1000, outputTokensEstimated: true, promptTokenCount: 10, finishedAtUtc: AT };
  try {
    assert.throws(() => recorder.recordToolResult(result), { code: 'SQLITE_FULL' });
    assertPrefixIntact(database, recorder.operationId, prefix);
  } finally {
    database.pragma('max_page_count = 1073741823');
  }

  assertStorageFailureIsFatal(database, recorder, prefix, 'SQLITE_FULL');
  rebuildChatRun(database, recorder.operationId);
  const tool = readChatRunMessages(database, SESSION_ID, recorder.operationId).find(message => message.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallExecutionState, 'uncertain');
  assert.equal(tool?.toolCallOutput, null);
});
