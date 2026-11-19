import type { RuntimeDatabase } from '../database-handle.ts';

// A literal, so later schema edits cannot change what the 95 to 96 upgrade creates.
const ENGINE_EVENTS_96_SQL = `
  CREATE TABLE engine_events_96 (
    id TEXT PRIMARY KEY,
    occurred_at_utc TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prompt_cache_break', 'engine_error', 'engine_exit', 'disk_cache_full')),
    inference_run_id TEXT,
    run_id TEXT,
    turn INTEGER,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  INSERT INTO engine_events_96 (id, occurred_at_utc, kind, inference_run_id, run_id, turn, summary, detail)
    SELECT id, occurred_at_utc, kind, inference_run_id, run_id, turn, summary, detail FROM engine_events;
  DROP TABLE engine_events;
  ALTER TABLE engine_events_96 RENAME TO engine_events;
  CREATE INDEX idx_engine_events_occurred ON engine_events(occurred_at_utc DESC);
  CREATE INDEX idx_engine_events_run ON engine_events(run_id);
`;

/** Schema 95 -> 96: engine_events accepts disk_cache_full; SQLite changes a CHECK only by rebuilding the table. */
export function upgradeEngineEventDiskCacheFull(database: RuntimeDatabase): void {
  database.exec(ENGINE_EVENTS_96_SQL);
}
