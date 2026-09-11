import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatOperationBroadcast,
  type ChatOperationClosure,
  type ChatOperationSubscriber,
} from '../src/status-server/chat-operation-broadcast.js';

class RecordingSubscriber implements ChatOperationSubscriber {
  published = 0;
  revisions = 0;
  readonly closures: ChatOperationClosure[] = [];

  onPublished(): void {
    this.published += 1;
  }

  onHistoryRevised(): void {
    this.revisions += 1;
  }

  onClosed(closure: ChatOperationClosure): void {
    this.closures.push(closure);
  }
}

test('a late subscriber is woken only by new publications; history belongs to the journal', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.publish();
  broadcast.publish();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  assert.equal(subscriber.published, 0);
  broadcast.publish();
  assert.equal(subscriber.published, 1);
});

test('every attached subscriber is woken by each publication', () => {
  const broadcast = new ChatOperationBroadcast();
  const first = new RecordingSubscriber();
  const second = new RecordingSubscriber();
  broadcast.attach(first);
  broadcast.attach(second);
  broadcast.publish();
  broadcast.publish();
  assert.equal(first.published, 2);
  assert.equal(second.published, 2);
});

test('detaching stops wake-ups without disturbing other subscribers', () => {
  const broadcast = new ChatOperationBroadcast();
  const leaving = new RecordingSubscriber();
  const staying = new RecordingSubscriber();
  broadcast.attach(leaving);
  broadcast.attach(staying);
  broadcast.detach(leaving);
  broadcast.publish();
  assert.equal(leaving.published, 0);
  assert.equal(staying.published, 1);
});

test('closing notifies every subscriber exactly once and drops later publications', () => {
  const broadcast = new ChatOperationBroadcast();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  broadcast.close();
  broadcast.close();
  broadcast.publish();
  broadcast.notifyHistoryRevised();
  assert.deepEqual(subscriber.closures, [{ failure: null }]);
  assert.equal(subscriber.published, 0);
  assert.equal(subscriber.revisions, 0);
  assert.equal(broadcast.isClosed(), true);
});

test('attaching to a closed broadcast closes immediately with the recorded closure', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.fail('provider exploded');
  broadcast.close();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  assert.equal(subscriber.published, 0);
  assert.deepEqual(subscriber.closures, [{ failure: 'provider exploded' }]);
});

test('the first failure wins, wakes readers, and is carried by the closing notice', () => {
  const broadcast = new ChatOperationBroadcast();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  assert.equal(broadcast.hasFailed(), false);
  broadcast.fail('first');
  broadcast.fail('second');
  assert.equal(broadcast.hasFailed(), true);
  assert.equal(subscriber.published, 2);
  broadcast.close();
  assert.deepEqual(subscriber.closures, [{ failure: 'first' }]);
  broadcast.fail('after close');
  assert.deepEqual(subscriber.closures, [{ failure: 'first' }]);
});

test('a history revision wakes attached subscribers separately from publications', () => {
  const broadcast = new ChatOperationBroadcast();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  broadcast.notifyHistoryRevised();
  assert.equal(subscriber.revisions, 1);
  assert.equal(subscriber.published, 0);
});
