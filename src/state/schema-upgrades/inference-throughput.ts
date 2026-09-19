import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../database-handle.js';

const ColumnNameRowsSchema = z.array(z.object({ name: z.string() }));

/** Every table that stores a canonical inference-throughput fold as JSON. */
const THROUGHPUT_TABLES = [
  'run_logs',
  'chat_messages',
  'benchmark_attempts',
  'runtime_metrics_totals',
  'idle_summary_snapshots',
] as const;

/**
 * 72 -> 73: add the nullable `throughput_json` column to every canonical table. A table the
 * upgrade expects but cannot find is a corrupted file, not a case to paper over, so it throws and
 * the caller's transaction leaves the marker at 72.
 */
export function upgradeInferenceThroughputSchema(database: RuntimeDatabase): void {
  for (const table of THROUGHPUT_TABLES) {
    const columns = ColumnNameRowsSchema.parse(
      database.prepare('SELECT name FROM pragma_table_info(?)').all(table),
    ).map((row) => row.name);
    if (columns.length === 0) {
      throw new Error(`Schema 72 is missing ${table}; cannot add throughput_json.`);
    }
    if (!columns.includes('throughput_json')) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN throughput_json TEXT`);
    }
  }
}
