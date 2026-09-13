import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { JsonObjectSchema } from '../src/lib/json-types.js';
import { ChatSubmissionStore, digestChatSubmission } from '../src/state/chat-submissions.js';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('submission receipts validate ownership, remain immutable, and cascade with their run', (t) => {
  t.after(closeAllRuntimeDatabases);
  const root = createManagedTempDir('chat-submissions-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const receipts = new ChatSubmissionStore(database);
  const submissionId = randomUUID();
  const requestDigest = 'a'.repeat(64);

  assert.equal(receipts.read(session.id, submissionId), null);
  receipts.insert({ sessionId: session.id, submissionId, requestDigest, runOperationId: recorder.operationId });
  assert.deepEqual(receipts.read(session.id, submissionId), {
    sessionId: session.id, submissionId, requestDigest, runOperationId: recorder.operationId,
  });
  assert.throws(() => receipts.insert({
    sessionId: session.id, submissionId, requestDigest: 'b'.repeat(64), runOperationId: recorder.operationId,
  }), /UNIQUE/u);

  const otherSession = { ...createTestChatSession(root), id: 'other-session' };
  saveChatSession(root, otherSession);
  assert.throws(() => receipts.insert({
    sessionId: otherSession.id, submissionId: randomUUID(), requestDigest, runOperationId: recorder.operationId,
  }), /session/u);

  database.prepare('DELETE FROM chat_runs WHERE operation_id = ?').run(recorder.operationId);
  assert.equal(receipts.read(session.id, submissionId), null);
});

test('submission receipt creation rolls back with its run', (t) => {
  t.after(closeAllRuntimeDatabases);
  const root = createManagedTempDir('chat-submission-rollback-');
  const session = createTestChatSession(root);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  saveChatSession(root, session);
  const receipts = new ChatSubmissionStore(database);
  const submissionId = randomUUID();

  assert.throws(() => database.transaction(() => {
    const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
    receipts.insert({
      sessionId: session.id, submissionId, requestDigest: 'c'.repeat(64), runOperationId: recorder.operationId,
    });
    throw new Error('rollback');
  })(), /rollback/u);
  assert.equal(receipts.read(session.id, submissionId), null);
  assert.equal(database.prepare('SELECT operation_id FROM chat_runs WHERE session_id = ?').get(session.id), undefined);
});

test('submission digests are canonical and contain no recoverable request payload', () => {
  const first = JsonObjectSchema.parse({ content: 'private prompt', operationId: randomUUID(), nested: { b: 2, a: 1 } });
  const reordered = JsonObjectSchema.parse({ nested: { a: 1, b: 2 }, operationId: first.operationId, content: 'private prompt' });
  const digest = digestChatSubmission('message', first);

  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(digest, digestChatSubmission('message', reordered));
  assert.notEqual(digest, digestChatSubmission('plan', reordered));
  assert.equal(digest.includes('private prompt'), false);
});
