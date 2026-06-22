import React, { useEffect, useRef } from 'react';

export type UseChatScrollResult = {
  chatLogRef: React.RefObject<HTMLDivElement | null>;
};

// Only the scroll offsets are read/written, so accept the minimal structural
// shape; a real HTMLDivElement satisfies it and tests can pass a plain stub.
type ScrollableElement = Pick<HTMLDivElement, 'scrollTop' | 'scrollHeight'>;

export function scrollChatLogToBottom(element: ScrollableElement | null): void {
  if (!element) {
    return;
  }
  element.scrollTop = element.scrollHeight;
}

export function useChatScroll(
  visibleMessageIdsKey: string,
  liveMessageScrollSignature: string,
): UseChatScrollResult {
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollChatLogToBottom(chatLogRef.current);
  }, [visibleMessageIdsKey, liveMessageScrollSignature]);
  return { chatLogRef };
}
