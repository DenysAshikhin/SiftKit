import test from 'node:test';
import assert from 'node:assert/strict';
import { addToast, removeToast, type ToastState } from '../dashboard/src/hooks/useToasts.js';

const empty: ToastState = { toasts: [], nextSeq: 0 };

test('blank or whitespace text is rejected', () => {
  assert.equal(addToast(empty, 'info', '   ').toasts.length, 0);
});
test('text is trimmed', () => {
  assert.equal(addToast(empty, 'info', '  hi  ').toasts[0]?.text, 'hi');
});
test('caps at five, dropping oldest', () => {
  let s = empty;
  for (let i = 0; i < 7; i += 1) s = addToast(s, 'info', `m${i}`);
  assert.equal(s.toasts.length, 5);
  assert.equal(s.toasts[0]?.text, 'm2');
});
test('removeToast drops by id', () => {
  const s = addToast(empty, 'error', 'x');
  const first = s.toasts[0];
  assert.ok(first);
  assert.deepEqual(removeToast(s, first.id).toasts, []);
});
