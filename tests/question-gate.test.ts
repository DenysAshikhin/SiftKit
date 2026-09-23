import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { QuestionGate, formatQuestionReply, type QuestionEvidenceSink } from '../src/repo-search/engine/question-gate.js';
import type { ChatQuestionRequestedEvidence, ChatQuestionResolvedEvidence } from '../src/repo-search/engine/chat-run-evidence.js';

class RecordingSink implements QuestionEvidenceSink {
  readonly controller = new AbortController();
  readonly requested: ChatQuestionRequestedEvidence[] = [];
  readonly resolved: ChatQuestionResolvedEvidence[] = [];
  get abortSignal(): AbortSignal { return this.controller.signal; }
  recordQuestionRequested(evidence: ChatQuestionRequestedEvidence): void { this.requested.push(evidence); }
  recordQuestionResolved(evidence: ChatQuestionResolvedEvidence): void { this.resolved.push(evidence); }
}

const CALL = { toolCallId: 'call-1', displayToolCallId: 'display-1', batchId: 'batch-1', turn: 1, indexInBatch: 0 };

test('an answer resolves the parked call and is journaled once', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink);
  const asked = gate.ask({ call: CALL, question: 'Which db?', choices: ['pg', 'sqlite'] });
  const questionId = gate.pendingQuestionId ?? '';
  assert.equal(sink.requested[0]?.questionId, questionId);
  assert.equal(gate.answer(questionId, { choiceIndex: 2, note: '' }), 'invalid_choice');
  assert.equal(gate.answer('4f9c1f9a-0000-4000-8000-0000000000ff', { choiceIndex: 0, note: '' }), 'not_pending');
  assert.equal(gate.answer(questionId, { choiceIndex: 1, note: 'local only' }), 'answered');
  assert.deepEqual(await asked, { choiceIndex: 1, note: 'local only' });
  assert.equal(gate.pendingQuestionId, null);
  assert.deepEqual(sink.resolved.map((row) => row.outcome), ['answered']);
  assert.equal(gate.answer(questionId, { choiceIndex: 0, note: '' }), 'not_pending');
});

test('stop rejects the parked call and journals aborted', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink);
  const asked = gate.ask({ call: CALL, question: 'Continue?', choices: [] });
  sink.controller.abort(new Error('Stopped by user.'));
  await assert.rejects(asked, /Stopped by user\./u);
  assert.deepEqual(sink.resolved.map((row) => row.outcome), ['aborted']);
});

test('an unanswered question expires, journals timeout and rejects', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink, 20);
  const asked = gate.ask({ call: CALL, question: 'Continue?', choices: [] });
  await assert.rejects(asked, /question timeout/u);
  assert.deepEqual(sink.resolved.map((row) => row.outcome), ['timeout']);
  await delay(5);
  assert.equal(gate.pendingQuestionId, null);
});

test('one question at a time, and a stopped run asks nothing', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink);
  const first = gate.ask({ call: CALL, question: 'A?', choices: [] });
  assert.throws(() => gate.ask({ call: CALL, question: 'B?', choices: [] }), /already waiting/u);
  sink.controller.abort(new Error('Stopped by user.'));
  await assert.rejects(first);
  await assert.rejects(gate.ask({ call: CALL, question: 'C?', choices: [] }), /Stopped by user\./u);
  assert.equal(sink.requested.length, 1);
});

test('replies read naturally to the model', () => {
  assert.equal(formatQuestionReply(['pg', 'sqlite'], { choiceIndex: 1, note: '' }), 'The user chose: sqlite');
  assert.equal(formatQuestionReply(['pg', 'sqlite'], { choiceIndex: 0, note: 'fast' }), 'The user chose: pg\nThe user added: fast');
  assert.equal(formatQuestionReply([], { choiceIndex: null, note: 'do X' }), 'The user replied: do X');
});
