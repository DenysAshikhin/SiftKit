import React, { useCallback, useEffect, useRef, useState } from 'react';

export type UseChatScrollResult = {
  /** Attach to the log, whose first child wraps its content; a size change of either re-follows a pinned log. */
  chatLogRef: React.RefCallback<HTMLDivElement>;
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

/** Scrolls the log to its bottom and returns where that left it, so the resulting scroll event never reads as moving up. */
function followBottom(log: HTMLDivElement): number {
  scrollChatLogToBottom(log);
  return log.scrollTop;
}

export function useChatScroll(sessionId: string, pendingApprovalId: string | null): UseChatScrollResult {
  const logRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  // Where the log was last left; only a move above it is the user leaving the bottom.
  const lastScrollTopRef = useRef(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  function pinToBottom(): void {
    if (logRef.current) lastScrollTopRef.current = followBottom(logRef.current);
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }

  function onChatLogScroll(): void {
    const element = logRef.current;
    if (!element) return;
    const movedUp = element.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;
    // Content growing under a pinned log fires scroll events too; those must not unpin it.
    if (isChatLogAtBottom(element)) {
      pinnedToBottomRef.current = true;
      setShowJumpToBottom(false);
    } else if (movedUp) {
      pinnedToBottomRef.current = false;
      setShowJumpToBottom(true);
    }
  }

  // A callback ref: the log mounts only once a session shows, and React 19 runs the returned cleanup on detach.
  const chatLogRef = useCallback((log: HTMLDivElement | null) => {
    if (!log) return undefined;
    const content = log.firstElementChild;
    if (!content) throw new Error('useChatScroll: the chat log has no content wrapper to observe.');
    logRef.current = log;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottomRef.current) lastScrollTopRef.current = followBottom(log);
    });
    observer.observe(content);
    observer.observe(log);
    return () => {
      observer.disconnect();
      logRef.current = null;
    };
  }, []);

  useEffect(() => { pinToBottom(); }, [sessionId]);

  useEffect(() => {
    if (pendingApprovalId !== null) pinToBottom();
  }, [pendingApprovalId]);

  return { chatLogRef, onChatLogScroll, jumpToBottom: pinToBottom, showJumpToBottom };
}
