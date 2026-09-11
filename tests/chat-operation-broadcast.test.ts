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

test('a late subscriber receives only new publications; history belongs to the journal', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('thinking', { turn: 0, offset: 0, text: 'a' });
  broadcast.writeEvent('thinking', { turn: 0, offset: 1, text: 'b' });
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  assert.equal(subscriber.frames.length, 0);
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'c' });
  assert.deepEqual(subscriber.frames.map((frame) => frame.event), ['answer']);
});

test('publications are serialized once and delivered identically to readers', () => {
  const broadcast = new ChatOperationBroadcast();
  const first = new RecordingSubscriber();
  const second = new RecordingSubscriber();
  broadcast.attach(first);
  broadcast.attach(second);
  broadcast.writeEvent('progress', { turn: 2, text: 'reading', elapsedMs: 40 });
  assert.deepEqual(first.frames, second.frames);
  assert.deepEqual(first.frames[0], {
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

test('attaching to a closed broadcast closes immediately without memory replay', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('done', { ok: true });
  broadcast.close();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  assert.equal(subscriber.frames.length, 0);
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

test('oversized publications reach current readers and are never retained for late readers', () => {
  const broadcast = new ChatOperationBroadcast();
  const live = new RecordingSubscriber();
  broadcast.attach(live);
  const text = '界'.repeat(3 * 1024 * 1024);
  broadcast.writeEvent('answer', { turn: 1, offset: 0, text });
  const frame = live.frames[0];
  assert.ok(frame);
  assert.equal(ChatStreamTextDeltaSchema.parse(JSON.parse(frame.data)).text, text);
  const late = new RecordingSubscriber();
  broadcast.attach(late);
  assert.equal(late.frames.length, 0);
});
