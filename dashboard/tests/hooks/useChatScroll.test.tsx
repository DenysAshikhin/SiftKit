import { render } from '../react-test-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { isChatLogAtBottom, scrollChatLogToBottom, useChatScroll } from '../../src/hooks/useChatScroll';

function LogProbe({ withContent }: { withContent: boolean }) {
  const { chatLogRef } = useChatScroll('s1', null);
  return <div ref={chatLogRef}>{withContent ? <div /> : null}</div>;
}

test('a log with its content wrapper mounts and unmounts cleanly', () => {
  const view = render(<LogProbe withContent />);
  view.unmount();
});

test('a log without its content wrapper fails loudly', () => {
  assert.throws(() => render(<LogProbe withContent={false} />), /content wrapper/u);
});

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
