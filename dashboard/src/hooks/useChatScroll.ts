import React, { useEffect, useRef } from 'react';

export type UseChatScrollResult = {
  chatLogRef: React.RefObject<HTMLDivElement | null>;
};

export function scrollChatLogToBottom(element: HTMLDivElement | null): void {
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
