import React, { useEffect, useRef, useState } from 'react';

export type UseChatScrollResult = {
  chatLogRef: React.RefObject<HTMLDivElement | null>;
  onChatLogScroll(): void;
  jumpToBottom(): void;
  showJumpToBottom: boolean;
};

type ScrollTarget = Pick<HTMLDivElement, 'scrollTop' | 'scrollHeight'>;
type ScrollableElement = ScrollTarget & Pick<HTMLDivElement, 'clientHeight'>;

const BOTTOM_THRESHOLD_PX = 4;

export function isChatLogAtBottom(element: ScrollableElement): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_THRESHOLD_PX;
}

export function scrollChatLogToBottom(element: ScrollTarget | null): void {
  if (!element) {
    return;
  }
  element.scrollTop = element.scrollHeight;
}

export function useChatScroll(
  sessionId: string,
  visibleMessageIdsKey: string,
  liveMessageScrollSignature: string,
  pendingApprovalId: string | null,
): UseChatScrollResult {
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  function onChatLogScroll(): void {
    const element = chatLogRef.current;
    if (!element) {
      return;
    }
    const pinnedToBottom = isChatLogAtBottom(element);
    pinnedToBottomRef.current = pinnedToBottom;
    setShowJumpToBottom(!pinnedToBottom);
  }

  function jumpToBottom(): void {
    scrollChatLogToBottom(chatLogRef.current);
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  useEffect(() => {
    scrollChatLogToBottom(chatLogRef.current);
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [sessionId]);

  useEffect(() => {
    if (pinnedToBottomRef.current) {
      scrollChatLogToBottom(chatLogRef.current);
    }
  }, [visibleMessageIdsKey, liveMessageScrollSignature]);

  useEffect(() => {
    if (pendingApprovalId === null) {
      return;
    }
    scrollChatLogToBottom(chatLogRef.current);
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [pendingApprovalId]);

  return { chatLogRef, onChatLogScroll, jumpToBottom, showJumpToBottom };
}
