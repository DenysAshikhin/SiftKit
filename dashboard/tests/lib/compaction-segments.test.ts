import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactionSegments, markEarlierRunsCompacted, splitAfterLastSummary } from '../../src/lib/compaction-segments';
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

/** Segments as rendered: fold boundaries and message order, ignoring how adjacent message runs are keyed. */
function renderedShape(segments: ReturnType<typeof buildCompactionSegments>): string[] {
  const shape: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'compaction') shape.push(`fold(${segment.summary?.id ?? 'orphan'}:${segment.originals.map((m) => m.id).join(',')})`);
    else shape.push(...segment.messages.map((m) => m.id));
  }
  return shape;
}

test('without a live summary, persisted then live segments render like the combined list', () => {
  const persisted = [msg({ id: 'p1' }), msg({ id: 'p2', compressedIntoSummary: true }), msg({ id: 'p3' })];
  const live = [msg({ id: 'l1' }), msg({ id: 'l2' })];
  assert.deepEqual(
    [...renderedShape(buildCompactionSegments(persisted)), ...renderedShape(buildCompactionSegments(live))],
    renderedShape(buildCompactionSegments([...persisted, ...live])),
  );
});

test('with a live summary, settled rows then open and live rows render like the combined list', () => {
  const persisted = [
    msg({ id: 'o1', compressedIntoSummary: true }), msg({ id: 's1', kind: 'compaction_summary' }), msg({ id: 'kept' }),
    msg({ id: 'after1' }), msg({ id: 'after2', compressedIntoSummary: true }),
  ];
  const live = [msg({ id: 'l1', compressedIntoSummary: true }), msg({ id: 's2', kind: 'compaction_summary' }), msg({ id: 'l2' })];
  const { settled, open } = splitAfterLastSummary(persisted);
  assert.deepEqual(settled.map((m) => m.id), ['o1', 's1']);
  assert.deepEqual(open.map((m) => m.id), ['kept', 'after1', 'after2']);
  assert.deepEqual(
    [...renderedShape(buildCompactionSegments(settled)), ...renderedShape(buildCompactionSegments([...open, ...live]))],
    renderedShape(buildCompactionSegments([...persisted, ...live])),
  );
});

test('with no stored summary every stored row stays open', () => {
  const persisted = [msg({ id: 'p1' }), msg({ id: 'p2' })];
  const { settled, open } = splitAfterLastSummary(persisted);
  assert.deepEqual(settled, []);
  assert.deepEqual(open.map((m) => m.id), ['p1', 'p2']);
});
