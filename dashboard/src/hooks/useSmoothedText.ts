import { useEffect, useRef, useState, type RefObject } from 'react';
import { SmoothStreamPacer } from '../lib/smooth-stream-pacer';

/** Frames sooner than this after the last advance are skipped: above ~60 fps re-rendering adds CPU, not smoothness. */
const MIN_ADVANCE_INTERVAL_MS = 12;

/**
 * Paces a live-streamed string so it appears to type smoothly regardless of
 * batched/bursty arrivals. Non-live text renders in full immediately, and
 * the first render always shows the full current text (static rendering and
 * fresh mounts never animate pre-existing text).
 */
export function useSmoothedText(text: string, live: boolean): string {
  const pacerRef = useRef<SmoothStreamPacer | null>(null);
  // One frame loop spans text updates; re-arming it per update starved it whenever updates outpaced frames.
  const frameRef = useRef<number | null>(null);
  const [displayedLength, setDisplayedLength] = useState(text.length);
  if (pacerRef.current === null) {
    pacerRef.current = new SmoothStreamPacer(text.length);
  }
  const pacer = pacerRef.current;

  useEffect(() => {
    if (!live) {
      stopFrameLoop(frameRef);
      setDisplayedLength(pacer.snap());
      return;
    }
    pacer.push(text.length, performance.now());
    if (pacer.isCaughtUp()) {
      stopFrameLoop(frameRef);
      setDisplayedLength(text.length);
      return;
    }
    if (frameRef.current !== null) {
      return;
    }
    let lastAdvanceAtMs = Number.NEGATIVE_INFINITY;
    const step = (atMs: number): void => {
      if (atMs - lastAdvanceAtMs >= MIN_ADVANCE_INTERVAL_MS) {
        lastAdvanceAtMs = atMs;
        setDisplayedLength(pacer.sample(atMs));
      }
      frameRef.current = pacer.isCaughtUp() ? null : requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [text, live, pacer]);

  useEffect(() => () => stopFrameLoop(frameRef), []);

  return live ? text.slice(0, Math.min(displayedLength, text.length)) : text;
}

function stopFrameLoop(frameRef: RefObject<number | null>): void {
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }
}
