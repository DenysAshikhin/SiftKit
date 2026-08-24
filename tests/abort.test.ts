import test from 'node:test';
import assert from 'node:assert/strict';

import { getAbortError, throwIfAborted } from '../src/lib/abort.js';

test('getAbortError prefers the abort reason when it is an Error', () => {
  const controller = new AbortController();
  const reason = new Error('custom reason');
  controller.abort(reason);
  assert.equal(getAbortError(controller.signal), reason);
});

test('getAbortError falls back to a default message', () => {
  const controller = new AbortController();
  controller.abort('plain-string');
  assert.equal(getAbortError(controller.signal).message, 'plain-string');
  assert.equal(getAbortError(undefined).message, 'Repo search aborted.');
});

test('throwIfAborted throws only when the signal is aborted', () => {
  const controller = new AbortController();
  throwIfAborted(controller.signal);
  throwIfAborted(undefined);
  controller.abort(new Error('stop'));
  assert.throws(() => throwIfAborted(controller.signal), /stop/u);
});
