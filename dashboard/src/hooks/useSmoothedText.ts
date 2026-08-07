import { useEffect, useRef, useState } from 'react';
import { SmoothStreamPacer } from '../lib/smooth-stream-pacer';

const FRAME_MS = 33;

/**
 * Paces a live-streamed string so it appears to type smoothly regardless of
 * batched/bursty arrivals. Non-live text renders in full immediately, and
 * the first render always shows the full current text (static rendering and
 * fresh mounts never animate pre-existing text).
 */
export function useSmoothedText(text: string, live: boolean): string {
  const pacerRef = useRef<SmoothStreamPacer | null>(null);
  const [displayedLength, setDisplayedLength] = useState(text.length);
  if (pacerRef.current === null) {
    pacerRef.current = new SmoothStreamPacer(text.length);
  }
  const pacer = pacerRef.current;

  useEffect(() => {
    if (!live) {
      setDisplayedLength(pacer.snap());
      return;
    }
    pacer.push(text.length, Date.now());
    if (pacer.isCaughtUp()) {
      setDisplayedLength(text.length);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = (): void => {
      if (cancelled) {
        return;
      }
      setDisplayedLength(pacer.sample(Date.now()));
      if (!pacer.isCaughtUp()) {
        timer = setTimeout(step, FRAME_MS);
      }
    };
    timer = setTimeout(step, FRAME_MS);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [text, live, pacer]);

  return live ? text.slice(0, Math.min(displayedLength, text.length)) : text;
}