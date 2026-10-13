import React from 'react';

/** The current time, re-read every `intervalMs` while `live`; idle panels never re-render. */
export function useNow(intervalMs: number, live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, live]);
  return now;
}
