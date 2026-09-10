import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STREAM_TERMINAL_EVENT_NAMES, ChatStreamTextDeltaSchema } from '@siftkit/contracts';

import {
  ChatOperationBroadcast,
  type ChatOperationFrame,
  type ChatOperationSubscriber,
} from '../src/status-server/chat-operation-broadcast.js';

class RecordingSubscriber implements ChatOperationSubscriber {
  readonly frames: ChatOperationFrame[] = [];
  closedCount = 0;

  onFrame(frame: ChatOperationFrame): void {
    this.frames.push(frame);
  }

  onClosed(): void {
    this.closedCount += 1;
  }
}

test('a late subscriber replays every frame in order and then receives live frames', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('thinking', { turn: 0, offset: 0, text: 'a' });
  broadcast.writeEvent('thinking', { turn: 0, offset: 1, text: 'b' });
  const subscriber = new RecordingSubscriber();
  const replay = broadcast.attach(subscriber);
  assert.deepEqual(
    replay.frames.map((frame) => ChatStreamTextDeltaSchema.parse(JSON.parse(frame.data)).text),
    ['a', 'b'],
  );
  assert.equal(replay.truncated, false);
  assert.equal(subscriber.frames.length, 0);
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'c' });
  assert.deepEqual(subscriber.frames.map((frame) => frame.event), ['answer']);
});

test('frames are serialized once and replayed byte-identically', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('progress', { turn: 2, text: 'reading', elapsedMs: 40 });
  const replay = broadcast.attach(new RecordingSubscriber());
  assert.deepEqual(replay.frames[0], {
    event: 'progress',
    data: '{"turn":2,"text":"reading","elapsedMs":40}',
  });
});

test('detaching stops delivery without disturbing other subscribers', () => {
  const broadcast = new ChatOperationBroadcast();
  const leaving = new RecordingSubscriber();
  const staying = new RecordingSubscriber();
  broadcast.attach(leaving);
  broadcast.attach(staying);
  broadcast.detach(leaving);
  broadcast.writeEvent('warning', { warning: 'w' });
  assert.equal(leaving.frames.length, 0);
  assert.equal(staying.frames.length, 1);
});

test('closing notifies every subscriber exactly once and drops later writes', () => {
  const broadcast = new ChatOperationBroadcast();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  broadcast.close();
  broadcast.close();
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'ignored' });
  assert.equal(subscriber.closedCount, 1);
  assert.equal(subscriber.frames.length, 0);
  assert.equal(broadcast.isClosed(), true);
});

test('attaching to a closed broadcast replays the buffer and closes immediately', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('done', { ok: true });
  broadcast.close();
  const subscriber = new RecordingSubscriber();
  const replay = broadcast.attach(subscriber);
  assert.equal(replay.frames.length, 1);
  assert.equal(subscriber.closedCount, 1);
});

test('every terminal frame name in the contract is remembered as terminal', () => {
  assert.deepEqual([...CHAT_STREAM_TERMINAL_EVENT_NAMES], ['done', 'error', 'ended']);
  for (const event of CHAT_STREAM_TERMINAL_EVENT_NAMES) {
    const broadcast = new ChatOperationBroadcast();
    broadcast.writeEvent('thinking', { turn: 0, offset: 0, text: 'a' });
    assert.equal(broadcast.hasTerminalFrame(), false, event);
    broadcast.writeEvent(event, event === 'error' ? { error: 'failed' } : {});
    assert.equal(broadcast.hasTerminalFrame(), true, event);
  }
});

test('the buffer drops the oldest frames past the byte ceiling and reports truncation', () => {
  const broadcast = new ChatOperationBroadcast(100);
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'first-frame-padding' });
  broadcast.writeEvent('answer', { turn: 0, offset: 1, text: 'second-frame-padding' });
  broadcast.writeEvent('answer', { turn: 0, offset: 2, text: 'third-frame-padding' });
  const replay = broadcast.attach(new RecordingSubscriber());
  assert.equal(replay.truncated, true);
  assert.ok(replay.frames.length < 3);
  assert.ok(replay.frames[replay.frames.length - 1]?.data.includes('third-frame-padding'));
});

test('replay enforces its byte ceiling even for one oversized multibyte frame and zero capacity', () => {
  for (const limit of [0, 64]) {
    const broadcast = new ChatOperationBroadcast(limit);
    const live = new RecordingSubscriber();
    broadcast.attach(live);
    broadcast.writeEvent('answer', { turn: 1, offset: 0, text: '界'.repeat(30) });
    assert.equal(live.frames.length, 1);
    const replay = broadcast.attach(new RecordingSubscriber());
    assert.equal(replay.frames.length, 0);
    assert.equal(replay.truncated, true);
  }
});
