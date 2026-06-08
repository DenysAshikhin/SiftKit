import { getRuntimeDatabase } from '../state/runtime-db.js';

export type WebSearchUsage = {
  currentMonth: string;
  currentMonthCount: number;
  allTimeCount: number;
};

export function getUsageMonthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function recordWebSearchUsage(metricsPath: string, delta: number, at: Date): void {
  if (!Number.isFinite(delta) || delta <= 0) {
    return;
  }
  const database = getRuntimeDatabase(metricsPath);
  database.prepare(`
    INSERT INTO web_search_usage (month, count) VALUES (?, ?)
    ON CONFLICT(month) DO UPDATE SET count = count + excluded.count
  `).run(getUsageMonthKey(at), Math.trunc(delta));
}

export function readWebSearchUsage(metricsPath: string, at: Date): WebSearchUsage {
  const database = getRuntimeDatabase(metricsPath);
  const month = getUsageMonthKey(at);
  const monthRow = database
    .prepare('SELECT count FROM web_search_usage WHERE month = ?')
    .get(month) as { count: number } | undefined;
  const totalRow = database
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM web_search_usage')
    .get() as { total: number };
  return {
    currentMonth: month,
    currentMonthCount: Number(monthRow?.count ?? 0),
    allTimeCount: Number(totalRow.total ?? 0),
  };
}
