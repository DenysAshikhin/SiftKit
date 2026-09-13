import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { waitForAbortableDelay } from '../src/lib/abortable-delay';

test('abortable delay removes its listener after its timer settles', async () => {
  const controller = new AbortController();
  const waiting = waitForAbortableDelay(controller.signal, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  await waiting;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abortable delay removes its listener when aborted', async () => {
  const controller = new AbortController();
  const waiting = waitForAbortableDelay(controller.signal, 60_000);
  controller.abort();
  await waiting;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
