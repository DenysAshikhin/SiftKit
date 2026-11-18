import type { RuntimeDatabase } from '../database-handle.ts';

// A literal, so later schema edits cannot change what the 93 to 94 upgrade creates.
const ENGINE_EVENTS_94_SQL = `
  CREATE TABLE IF NOT EXISTS engine_events (
    id TEXT PRIMARY KEY,
    occurred_at_utc TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prompt_cache_break', 'engine_error', 'engine_exit')),
    inference_run_id TEXT,
    run_id TEXT,
    turn INTEGER,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_engine_events_occurred ON engine_events(occurred_at_utc DESC);
  CREATE INDEX IF NOT EXISTS idx_engine_events_run ON engine_events(run_id);
`;

/** Schema 93 -> 94: adds the engine_events table. */
export function upgradeEngineEvents(database: RuntimeDatabase): void {
  database.exec(ENGINE_EVENTS_94_SQL);
}
