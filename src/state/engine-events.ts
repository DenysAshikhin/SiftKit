import { randomUUID } from 'node:crypto';

import { EngineEventKindSchema, type EngineEvent } from '@siftkit/contracts';
import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from './database-handle.ts';

/** Detail beyond this keeps its end, where a traceback's exception line is. */
export const ENGINE_EVENT_DETAIL_MAX_CHARS = 16_000;

export type EngineEventInput = Omit<EngineEvent, 'id' | 'occurredAtUtc'>;

const EngineEventRowSchema = z.object({
  id: z.string(),
  occurred_at_utc: z.string(),
  kind: EngineEventKindSchema,
  inference_run_id: z.string().nullable(),
  run_id: z.string().nullable(),
  turn: z.number().int().nullable(),
  summary: z.string(),
  detail: z.string(),
});
const RunCountRowSchema = z.object({ run_id: z.string(), count: z.number() });

export function insertEngineEvent(database: RuntimeDatabase, input: EngineEventInput): void {
  const detail = input.detail.length > ENGINE_EVENT_DETAIL_MAX_CHARS ? input.detail.slice(-ENGINE_EVENT_DETAIL_MAX_CHARS) : input.detail;
  database.prepare(`
    INSERT INTO engine_events (id, occurred_at_utc, kind, inference_run_id, run_id, turn, summary, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), new Date().toISOString(), input.kind, input.inferenceRunId, input.runId, input.turn, input.summary, detail);
}

/** The newest `limit` events of every kind. */
export function listEngineEvents(database: RuntimeDatabase, limit: number): EngineEvent[] {
  const rows = z.array(EngineEventRowSchema).parse(database.prepare(`
    SELECT id, occurred_at_utc, kind, inference_run_id, run_id, turn, summary, detail
    FROM engine_events ORDER BY occurred_at_utc DESC, rowid DESC LIMIT ?
  `).all(limit));
  return rows.map((row) => ({
    id: row.id,
    occurredAtUtc: row.occurred_at_utc,
    kind: row.kind,
    inferenceRunId: row.inference_run_id,
    runId: row.run_id,
    turn: row.turn,
    summary: row.summary,
    detail: row.detail,
  }));
}

/** Cache-break counts of the given runs; runs without breaks are absent. */
export function countPromptCacheBreaksByRun(database: RuntimeDatabase, runIds: readonly string[]): Map<string, number> {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => '?').join(', ');
  const rows = z.array(RunCountRowSchema).parse(database.prepare(`
    SELECT run_id, COUNT(*) AS count FROM engine_events
    WHERE kind = 'prompt_cache_break' AND run_id IN (${placeholders}) GROUP BY run_id
  `).all(...runIds));
  return new Map(rows.map((row) => [row.run_id, row.count]));
}

export function deleteEngineEventsForRuns(database: RuntimeDatabase, runIds: readonly string[]): number {
  if (runIds.length === 0) return 0;
  const placeholders = runIds.map(() => '?').join(', ');
  return Number(database.prepare(`DELETE FROM engine_events WHERE run_id IN (${placeholders})`).run(...runIds).changes);
}

export function deleteEngineEventsForInferenceRun(database: RuntimeDatabase, inferenceRunId: string): number {
  return Number(database.prepare('DELETE FROM engine_events WHERE inference_run_id = ?').run(inferenceRunId).changes);
}
