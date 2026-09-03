import test from 'node:test';
import assert from 'node:assert/strict';

import { isChatLogAtBottom, scrollChatLogToBottom } from '../../src/hooks/useChatScroll';

test('isChatLogAtBottom accepts only the four-pixel bottom boundary', () => {
  assert.equal(isChatLogAtBottom({ scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 }), true);
  assert.equal(isChatLogAtBottom({ scrollTop: 796, scrollHeight: 1_000, clientHeight: 200 }), true);
  assert.equal(isChatLogAtBottom({ scrollTop: 795, scrollHeight: 1_000, clientHeight: 200 }), false);
  assert.equal(isChatLogAtBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 }), true);
});

test('scrollChatLogToBottom sets scrollTop to scrollHeight when given a live element', () => {
  const element = { scrollTop: 0, scrollHeight: 480 };
  scrollChatLogToBottom(element);
  assert.equal(element.scrollTop, 480);
});

test('scrollChatLogToBottom is a no-op when the element is null', () => {
  assert.doesNotThrow(() => scrollChatLogToBottom(null));
});

test('scrollChatLogToBottom keeps scrollTop at scrollHeight after subsequent updates', () => {
  const element = { scrollTop: 0, scrollHeight: 100 };
  scrollChatLogToBottom(element);
  assert.equal(element.scrollTop, 100);
  element.scrollHeight = 250;
  scrollChatLogToBottom(element);
  assert.equal(element.scrollTop, 250);
});
