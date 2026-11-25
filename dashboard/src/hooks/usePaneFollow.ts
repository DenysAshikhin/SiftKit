import React from 'react';

/** How far from its target a pane may be and still count as following it. */
const FOLLOW_THRESHOLD_PX = 24;

/** Where a following pane sits: at the element `selector` names, under the pane's sticky header, or at its end. */
function followTop(pane: HTMLElement, selector: string | null): number {
  const end = Math.max(0, pane.scrollHeight - pane.clientHeight);
  const target = selector === null ? null : pane.querySelector(selector);
  if (target === null) return selector === null ? end : pane.scrollTop;
  const header = pane.firstElementChild?.getBoundingClientRect().height ?? 0;
  return Math.max(0, Math.min(end, pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - header));
}

/** Keeps a scrolling pane on its newest content until the user scrolls away or opens something in it; scrolling back resumes. */
export function usePaneFollow<Pane extends HTMLElement>(selector: string | null) {
  const paneRef = React.useRef<Pane>(null);
  const followingRef = React.useRef(true);
  React.useLayoutEffect(() => {
    const pane = paneRef.current;
    if (pane !== null && followingRef.current) pane.scrollTop = followTop(pane, selector);
  });
  return {
    paneRef,
    onScroll: (event: React.UIEvent<HTMLElement>) => {
      const pane = event.currentTarget;
      followingRef.current = Math.abs(pane.scrollTop - followTop(pane, selector)) <= FOLLOW_THRESHOLD_PX;
    },
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest('summary') !== null) followingRef.current = false;
    },
  };
}
