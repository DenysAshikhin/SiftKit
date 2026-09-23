import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, requestSse, asObject, asObjectArray } from './helpers/dashboard-http.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import type { ChatJournalEvent } from '../src/state/chat-journal-schema.js';

/** Every event the session's runs committed; the message route journals under its own operation id. */
function readEvents(sessionId: string): ChatJournalEvent[] {
  const store = new ChatJournalStore(getRuntimeDatabase());
  return store.listSessionRuns(sessionId).flatMap((run) => Array.from(store.readAll(run.operationId), (envelope) => envelope.event));
}

/** The question the session's run asked; it commits before parking, so poll until it lands. */
async function waitForQuestionId(sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    for (const event of readEvents(sessionId)) if (event.kind === 'question_requested') return event.questionId;
    await delay(10);
  }
  throw new Error(`No question was asked; the session committed: ${readEvents(sessionId).map((event) => event.kind).join(', ')}.`);
}

function readQuestionOutcome(sessionId: string): string | null {
  for (const event of readEvents(sessionId)) if (event.kind === 'question_resolved') return event.outcome;
  return null;
}

async function createSession(baseUrl: string): Promise<string> {
  return String(asObject((await requestJson(`${baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'question' }) })).body.session).id);
}

const ASK = { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which database?', choices: ['PostgreSQL', 'SQLite'] } }] };

test('ask_user parks the run until the user answers, then the model sees the answer', async (t) => {
  const harness = await startHarness('siftkit-chat-question-', t);
  const sessionId = await createSession(harness.baseUrl);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  const running = requestSse(`${url}/messages/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'pick a db', mockResponses: [ASK, { content: 'Using SQLite.' }],
  }) });
  const questionId = await waitForQuestionId(sessionId);
  const post = (reply: { choiceIndex: number | null; note: string }) =>
    requestJson(`${url}/question`, { method: 'POST', body: JSON.stringify({ questionId, reply }) });
  assert.equal((await post({ choiceIndex: 2, note: '' })).statusCode, 400);
  assert.equal((await post({ choiceIndex: null, note: '' })).statusCode, 400);
  assert.equal((await post({ choiceIndex: 1, note: 'keep it local' })).statusCode, 200);
  assert.equal((await post({ choiceIndex: 1, note: '' })).statusCode, 409);
  await running;
  const messages = asObjectArray(asObject((await requestJson(url)).body.session).messages);
  const tool = messages.find((row) => row.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallActivityKind, 'ask');
  assert.equal(tool?.toolCallOutput, 'The user chose: SQLite\nThe user added: keep it local');
  assert.equal(messages.at(-1)?.content, 'Using SQLite.');
});

test('Stop while a question waits ends the run and records the question as aborted', async (t) => {
  const harness = await startHarness('siftkit-chat-question-stop-', t);
  const sessionId = await createSession(harness.baseUrl);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  const operationId = randomUUID();
  const running = requestSse(`${url}/messages/stream`, { method: 'POST', body: JSON.stringify({
    operationId, submissionId: randomUUID(), content: 'pick a db', mockResponses: [ASK, { content: 'unreachable' }],
  }) });
  await waitForQuestionId(sessionId);
  assert.equal((await requestJson(`${url}/stop`, { method: 'POST', body: JSON.stringify({ operationId }) })).statusCode, 200);
  await running;
  assert.equal(readQuestionOutcome(sessionId), 'aborted');
  const messages = asObjectArray(asObject((await requestJson(url)).body.session).messages);
  assert.equal(messages.find((row) => row.kind === 'assistant_tool_call')?.toolCallExecutionState, 'rejected');
  assert.ok(messages.some((row) => row.runTerminalCause === 'user_stop'));
  assert.equal(messages.some((row) => row.content === 'unreachable'), false);
});

test('answering with no waiting question is a conflict', async (t) => {
  const harness = await startHarness('siftkit-chat-question-none-', t);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const response = await requestJson(`${url}/question`, { method: 'POST', body: JSON.stringify({
    questionId: randomUUID(), reply: { choiceIndex: null, note: 'hello' },
  }) });
  assert.equal(response.statusCode, 409);
});
