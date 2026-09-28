import React from 'react';
import { MarkdownBlocks } from './MarkdownContent';
import { streamTailStart } from '../lib/markdown-blocks';
import { SmoothStreamPacer } from '../lib/smooth-stream-pacer';

/** Every tail write makes Chrome present a frame; above ~30 Hz that costs GPU and CPU (measured), not smoothness. */
export const STREAM_ADVANCE_INTERVAL_MS = 33;

export type StreamFormat = 'markdown' | 'plain';

/** Where the still-growing part of `tail` starts; plain text commits whole paragraphs. */
function tailStart(tail: string, format: StreamFormat): { start: number; inFence: boolean } {
  if (format === 'markdown') return streamTailStart(tail);
  const paragraphEnd = tail.lastIndexOf('\n\n');
  return { start: paragraphEnd === -1 ? 0 : paragraphEnd + 2, inFence: false };
}

/**
 * Paces live text like a typewriter without a React render per frame: React renders only finished blocks,
 * and a timer writes the growing tail straight into one DOM node. Non-live text renders in full at once,
 * and a fresh mount shows all existing text (static rendering never animates pre-existing text).
 */
export function LiveStreamedText({ text, live, format }: { text: string; live: boolean; format: StreamFormat }) {
  const [initial] = React.useState(() => {
    const start = live ? tailStart(text, format).start : 0;
    return { start, tail: text.slice(start) };
  });
  const [committedEnd, setCommittedEnd] = React.useState(initial.start);
  const pacerRef = React.useRef<SmoothStreamPacer | null>(null);
  if (pacerRef.current === null) {
    pacerRef.current = new SmoothStreamPacer(text.length);
  }
  const pacer = pacerRef.current;
  const textRef = React.useRef(text);
  const shownRef = React.useRef(text.length);
  const renderedEndRef = React.useRef(committedEnd);
  const tailRef = React.useRef<HTMLSpanElement | null>(null);
  const timerRef = React.useRef<number | null>(null);

  // Writes the shown tail; a finished block is handed to React, whose commit rewrites the shorter tail.
  const writeTail = React.useCallback(() => {
    const node = tailRef.current;
    if (!node) return;
    const tail = textRef.current.slice(renderedEndRef.current, shownRef.current);
    const { start, inFence } = tailStart(tail, format);
    if (start > 0) setCommittedEnd(renderedEndRef.current + start);
    node.textContent = tail;
    node.toggleAttribute('data-fence', inFence);
  }, [format]);

  React.useLayoutEffect(() => {
    renderedEndRef.current = committedEnd;
    writeTail();
  }, [committedEnd, live, writeTail]);

  React.useEffect(() => {
    textRef.current = text;
    if (!live) {
      stopTimer(timerRef);
      shownRef.current = pacer.snap();
      return;
    }
    pacer.push(text.length, performance.now());
    if (pacer.isCaughtUp()) {
      stopTimer(timerRef);
      shownRef.current = text.length;
      writeTail();
      return;
    }
    if (timerRef.current !== null) return;
    const step = (): void => {
      shownRef.current = pacer.sample(performance.now());
      writeTail();
      timerRef.current = pacer.isCaughtUp() ? null : window.setTimeout(step, STREAM_ADVANCE_INTERVAL_MS);
    };
    timerRef.current = window.setTimeout(step, STREAM_ADVANCE_INTERVAL_MS);
  }, [text, live, pacer, writeTail]);

  React.useEffect(() => () => stopTimer(timerRef), []);

  // Markdown drops the newline separating the committed blocks from the tail, as the block split does.
  const committed = format === 'markdown' ? text.slice(0, Math.max(0, committedEnd - 1)) : text.slice(0, committedEnd);
  const shown = live ? committed : text;
  return (
    <>
      {format === 'markdown' ? <MarkdownBlocks content={shown} /> : shown}
      {/* The mount-time tail serves static rendering; the unchanging child means React never rewrites the paced text. */}
      {live ? <span className="stream-tail" ref={tailRef}>{initial.tail}</span> : null}
    </>
  );
}

function stopTimer(timerRef: React.RefObject<number | null>): void {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}
