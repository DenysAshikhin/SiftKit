import test from 'node:test';
import assert from 'node:assert/strict';

import { scrollChatLogToBottom } from '../../src/hooks/useChatScroll';

test('scrollChatLogToBottom sets scrollTop to scrollHeight when given a live element', () => {
  const element = { scrollTop: 0, scrollHeight: 480 } as HTMLDivElement;
  scrollChatLogToBottom(element);
  assert.equal(element.scrollTop, 480);
});

test('scrollChatLogToBottom is a no-op when the element is null', () => {
  assert.doesNotThrow(() => scrollChatLogToBottom(null));
});

test('scrollChatLogToBottom keeps scrollTop at scrollHeight after subsequent updates', () => {
  const element = { scrollTop: 0, scrollHeight: 100 } as HTMLDivElement;
  scrollChatLogToBottom(element);
  assert.equal(element.scrollTop, 100);
  element.scrollHeight = 250;
  scrollChatLogToBottom(element);
  assert.equal(element.scrollTop, 250);
});
