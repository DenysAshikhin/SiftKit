import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { buildChatRunMessageIdPrefix } from '@siftkit/contracts';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { deleteChatMessage, readChatSessionFromPath, getChatSessionPath } from '../src/state/chat-sessions.js';
import { rebuildChatRun } from '../src/status-server/chat-run-projection.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';

test('deleted answer stays absent from display rebuild and retained model context', () => {
  const root = createManagedTempDir('chat-retention-delete-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const answerId = `${buildChatRunMessageIdPrefix(recorder.operationId)}-answer-final`;
  recorder.recordContextInitialized({ messages: [
    { role: 'user', content: 'question' }, { role: 'assistant', content: 'removed answer', chatMessageId: answerId },
  ], contextRevision: 0, turnBoundary: 0 });
  recorder.completeAnswer({ content: 'removed answer' });
  assert.ok(deleteChatMessage(root, session.id, answerId));
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  rebuildChatRun(database, recorder.operationId);
  assert.equal(readChatSessionFromPath(getChatSessionPath(root, session.id))?.messages?.some(message => message.id === answerId), false);
  assert.equal(JSON.stringify(buildRecoveredChatHistory(database, session.id).messages).includes('removed answer'), false);
});
