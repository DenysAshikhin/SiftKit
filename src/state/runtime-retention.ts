export const DEFAULT_RUNTIME_HISTORY_RETENTION_DAYS = 7;

export function getRuntimeHistoryRetentionDays(): number {
  const configured = Number.parseInt(
    process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS || '',
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RUNTIME_HISTORY_RETENTION_DAYS;
}
