import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactionSegments, markEarlierRunsCompacted } from '../../src/lib/compaction-segments';
import { ChatMessageSchema, type ChatMessage } from '../../src/types';

function msg(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return ChatMessageSchema.parse({ role: 'assistant', kind: 'assistant_answer', content: '', inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-09-22T00:00:00Z', sourceRunId: null, ...overrides });
}

test('an uncompacted transcript is one message segment', () => {
  const rows = [msg({ id: 'a' }), msg({ id: 'b' })];
  assert.deepEqual(buildCompactionSegments(rows).map((segment) => segment.kind), ['messages']);
});

test('each summary gets its own fold, in order, with retained rows after it', () => {
  const rows = [
    msg({ id: 'o1', compressedIntoSummary: true }),
    msg({ id: 's1', kind: 'compaction_summary', compressedIntoSummary: true }),
    msg({ id: 'kept', role: 'user', kind: 'user_text' }),
    msg({ id: 'm1', compressedIntoSummary: true }),
    msg({ id: 's2', kind: 'compaction_summary' }),
    msg({ id: 'n1' }),
  ];
  const segments = buildCompactionSegments(rows);
  assert.deepEqual(segments.map((segment) => segment.kind === 'compaction'
    ? `fold:${segment.summary?.id}:${segment.originals.map((row) => row.id).join(',')}`
    : `rows:${segment.messages.map((row) => row.id).join(',')}`), [
    'fold:s1:o1',
    'fold:s2:m1',
    'rows:kept',
    'rows:n1',
  ]);
});

test('flagged rows whose summary was deleted still fold, ahead of the retained rows', () => {
  const segments = buildCompactionSegments([msg({ id: 'o1', compressedIntoSummary: true }), msg({ id: 'n1' })]);
  assert.deepEqual(segments.map((segment) => segment.kind), ['compaction', 'messages']);
  assert.equal(segments[0]?.kind === 'compaction' ? segments[0].summary : 'x', null);
});

test('a reported live compaction folds earlier runs the stale saved transcript still shows', () => {
  const persisted = [msg({ id: 'p1', sourceRunId: 'run-a' }), msg({ id: 'p2', sourceRunId: 'run-a', compressedIntoSummary: true })];
  assert.deepEqual(markEarlierRunsCompacted(persisted, true).map((row) => row.compressedIntoSummary), [true, true]);
  assert.equal(markEarlierRunsCompacted(persisted, false), persisted);
});

test('flagged rows after the last summary join that summary fold', () => {
  const segments = buildCompactionSegments([
    msg({ id: 'o1', compressedIntoSummary: true }),
    msg({ id: 's1', kind: 'compaction_summary' }),
    msg({ id: 'n1' }),
    msg({ id: 'late', compressedIntoSummary: true }),
  ]);
  assert.deepEqual(segments.map((segment) => segment.kind === 'compaction'
    ? `fold:${segment.summary?.id}:${segment.originals.map((row) => row.id).join(',')}`
    : `rows:${segment.messages.map((row) => row.id).join(',')}`), ['fold:s1:o1,late', 'rows:n1']);
});
