import type { RuntimeDatabase } from '../../src/state/database-handle.ts';

/** Removes what schema 88 added, so a fresh database stands in for a real 87 file. */
export function downgradeVaultTo87(database: RuntimeDatabase): void {
  database.exec(`
    DROP INDEX IF EXISTS vault_notes_validation_idx;
    DROP INDEX IF EXISTS vault_fact_points_validation_idx;
    DROP TABLE IF EXISTS vault_fact_points;
    DROP TABLE IF EXISTS vault_rollup_days;
    ALTER TABLE vault_notes DROP COLUMN last_accessed_at_utc;
    ALTER TABLE vault_notes DROP COLUMN validated_at_utc;
  `);
}
