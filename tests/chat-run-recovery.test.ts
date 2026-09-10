import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { ChatRuntimeOwner } from '../src/state/chat-runtime-owner.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { recoverInterruptedChatRuns } from '../src/status-server/chat-run-recovery.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';

test('startup closes an orphaned started tool as uncertain without losing its submission', () => {
  const root = createManagedTempDir('chat-orphan-recovery-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ messages: [{ role: 'user', content: 'find target' }], contextRevision: 0, turnBoundary: 0 });
  const call = { toolCallId: 'call-a', displayToolCallId: 'display-a', batchId: 'batch-a', turn: 1, indexInBatch: 0 };
  recorder.recordToolProposed({ call, toolName: 'run', arguments: { command: 'potential effect' }, command: 'potential effect',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 2, promptTokenCount: 10, executionState: 'proposed' });
  recorder.recordToolStarted({ call, startedAtUtc: new Date().toISOString() });
  const databasePath = join(root, 'runtime.sqlite');
  const owner = ChatRuntimeOwner.acquire(databasePath, 'new-process');
  const database = getRuntimeDatabase(databasePath);
  recoverInterruptedChatRuns(database, owner.ownerEpoch);
  const store = new ChatJournalStore(database);
  assert.equal(store.readRun(recorder.operationId)?.terminalCause, 'server_restart');
  const history = buildRecoveredChatHistory(database, session.id);
  assert.notEqual(history.status, 'recovery_failed');
  assert.equal(history.messages[0]?.content, 'find target');
  assert.match(String(history.messages.find(message => message.role === 'tool')?.content), /Outcome uncertain/);
  const committed = store.readRun(recorder.operationId)?.latestSequence;
  recoverInterruptedChatRuns(database, owner.ownerEpoch);
  assert.equal(store.readRun(recorder.operationId)?.latestSequence, committed);
  assert.throws(() => recorder.recordToolStarted({ call, startedAtUtc: new Date().toISOString() }), /owner|fenced/u);
});
