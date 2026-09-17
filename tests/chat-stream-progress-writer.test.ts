import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatTranscriptEvent } from '@siftkit/contracts';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { ChatStreamProgressWriter } from '../src/status-server/chat-stream-progress-writer.js';
import { LIVE_TEXT_FLUSH_MAX_LATENCY_MS } from '../src/status-server/live-text-delta.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { beginRepoAgentTestRun } from './helpers/chat-run-recorder.js';

function fixture() {
  const { database, recorder } = beginRepoAgentTestRun('chat-stream-progress-writer-');
  let publishes = 0;
  const writer = new ChatStreamProgressWriter({ publish: () => { publishes += 1; } }, null, true, recorder);
  const displayEvents = (): ChatTranscriptEvent[] => {
    const events: ChatTranscriptEvent[] = [];
    for (const envelope of new ChatJournalStore(database).readAll(recorder.operationId)) {
      if (envelope.event.kind === 'display') events.push(envelope.event.event);
    }
    return events;
  };
  return { writer, displayEvents, publishes: () => publishes };
}

function progressUpdate(turn: number, progressText: string): RepoSearchProgressEvent {
  return { kind: 'progress_update', taskId: 'task', turn, maxTurns: 200, elapsedMs: 1, progressText };
}

test('progress_update tokens within the flush window coalesce into one progress journal row', () => {
  const { writer, displayEvents, publishes } = fixture();
  let text = '';
  for (let index = 0; index < 50; index++) {
    text += `tok${index} `;
    writer.write(progressUpdate(1, text));
  }
  assert.deepEqual(displayEvents(), []);
  assert.equal(publishes(), 0);
  writer.flushPending();
  assert.deepEqual(displayEvents(), [{ kind: 'progress', delta: { turn: 1, offset: 0, text } }]);
  assert.equal(publishes(), 1);
});

test('a tool_start flushes pending progress before its own row', () => {
  const { writer, displayEvents } = fixture();
  writer.write(progressUpdate(1, 'calling'));
  writer.write({
    kind: 'tool_start', toolCallId: 'call-1', turn: 1, maxTurns: 200, activityKind: 'read',
    activitySubject: { kind: 'file', value: 'a.ts' }, command: 'read path="a.ts"', promptTokenCount: 0, thinkingTokenCount: 0, elapsedMs: 2,
  });
  assert.deepEqual(displayEvents().map((event) => event.kind), ['progress', 'tool']);
  assert.deepEqual(displayEvents()[0], { kind: 'progress', delta: { turn: 1, offset: 0, text: 'calling' } });
});

test('a new turn yields an offset-zero progress delta and the same turn appends', () => {
  const { writer, displayEvents } = fixture();
  writer.write(progressUpdate(1, 'first'));
  writer.flushPending();
  writer.write(progressUpdate(1, 'first more'));
  writer.flushPending();
  writer.write(progressUpdate(2, 'second'));
  writer.flushPending();
  assert.deepEqual(displayEvents(), [
    { kind: 'progress', delta: { turn: 1, offset: 0, text: 'first' } },
    { kind: 'progress', delta: { turn: 1, offset: 5, text: ' more' } },
    { kind: 'progress', delta: { turn: 2, offset: 0, text: 'second' } },
  ]);
});

test('pending progress flushes on the latency timer without another event', (t) => {
  const { writer, displayEvents } = fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  writer.write(progressUpdate(1, 'slow'));
  assert.deepEqual(displayEvents(), []);
  t.mock.timers.tick(LIVE_TEXT_FLUSH_MAX_LATENCY_MS);
  assert.deepEqual(displayEvents(), [{ kind: 'progress', delta: { turn: 1, offset: 0, text: 'slow' } }]);
});