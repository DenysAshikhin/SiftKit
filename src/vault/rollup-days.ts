import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';

const RollupDayRowsSchema = z.array(z.object({ day: z.string() }));

/** Marks a local day whose daily note needs rebuilding; maintenance rebuilds and clears it. */
export function markRollupDay(database: RuntimeDatabase, day: string): void {
  database.prepare('INSERT OR IGNORE INTO vault_rollup_days (day) VALUES (?)').run(day);
}

export function listRollupDays(database: RuntimeDatabase): string[] {
  return RollupDayRowsSchema.parse(database.prepare('SELECT day FROM vault_rollup_days ORDER BY day').all()).map((row) => row.day);
}

export function clearRollupDay(database: RuntimeDatabase, day: string): void {
  database.prepare('DELETE FROM vault_rollup_days WHERE day = ?').run(day);
}
