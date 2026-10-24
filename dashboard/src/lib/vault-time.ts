const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const HOUR_BUCKET_LIMIT_MINUTES = 48 * MINUTES_PER_HOUR;
const MINUTES_PER_DAY = 1440;

export function ago(iso: string, nowMs: number): string {
  const minutes = (nowMs - Date.parse(iso)) / MINUTE_MS;
  if (minutes < 1) return 'just now';
  if (minutes < MINUTES_PER_HOUR) return `${Math.round(minutes)}m ago`;
  if (minutes < HOUR_BUCKET_LIMIT_MINUTES) return `${Math.round(minutes / MINUTES_PER_HOUR)}h ago`;
  return `${Math.round(minutes / MINUTES_PER_DAY)}d ago`;
}

export const fmtTime = (iso: string): string => iso.replace('T', ' ').slice(0, 16);
