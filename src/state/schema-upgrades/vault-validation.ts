import { z } from '../../lib/zod.ts';
import { syncFactPoints } from '../../vault/fact-points.ts';
import { VAULT_VALIDATION_TABLES_SQL } from '../../vault/vault-schema.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const ColumnNameRowsSchema = z.array(z.object({ name: z.string() }));
const NoteRowsSchema = z.array(z.object({ id: z.string(), body: z.string(), updated_at_utc: z.string() }));
const TIMESTAMP_COLUMNS = ['last_accessed_at_utc', 'validated_at_utc'] as const;

/** Schema 87 -> 88: note and fact-value timestamps, backfilled so the whole vault enters the validation queue. */
export function upgradeVaultValidation(database: RuntimeDatabase): void {
  const columns = ColumnNameRowsSchema.parse(database.prepare('SELECT name FROM pragma_table_info(?)').all('vault_notes')).map((row) => row.name);
  if (columns.length === 0) throw new Error('Schema 87 is missing vault_notes; cannot add validation timestamps.');
  for (const column of TIMESTAMP_COLUMNS) {
    if (!columns.includes(column)) database.exec(`ALTER TABLE vault_notes ADD COLUMN ${column} TEXT`);
  }
  database.exec(VAULT_VALIDATION_TABLES_SQL);
  for (const note of NoteRowsSchema.parse(database.prepare('SELECT id, body, updated_at_utc FROM vault_notes').all())) {
    syncFactPoints(database, note.id, note.body, note.updated_at_utc);
  }
}
