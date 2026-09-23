import React from 'react';

/** setTimeout fires at once for longer delays, which would expire a far-future deadline immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** True once `expiresAtUtc` has passed; flips on time without polling. */
export function useExpired(expiresAtUtc: string): boolean {
  const expiresAt = Date.parse(expiresAtUtc);
  const [expired, setExpired] = React.useState(() => Date.now() >= expiresAt);
  React.useEffect(() => {
    const remaining = expiresAt - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0 || remaining > MAX_TIMER_DELAY_MS) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expired;
}
