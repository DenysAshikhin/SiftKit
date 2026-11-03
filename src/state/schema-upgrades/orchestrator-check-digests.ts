import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const AttemptRowsSchema = z.array(z.object({ run_id: z.string(), child_run_id: z.string(), attempt_json: z.string() }));
// Pins only what this step reads from schema-89 attempts: each settled result's check list.
const Stored89AttemptSchema = z.object({
  result: z.object({ checks: z.array(z.object({}).catchall(JsonValueSchema)) }).catchall(JsonValueSchema).nullable(),
}).catchall(JsonValueSchema);

/** Schema 89 -> 90: check results gain `digest`; output stored before digests existed has none, so it is null. */
export function upgradeOrchestratorCheckDigests(database: RuntimeDatabase): void {
  const rows = AttemptRowsSchema.parse(database.prepare('SELECT run_id, child_run_id, attempt_json FROM orchestrator_attempts').all());
  const updates = rows.flatMap((row) => {
    const parsed = Stored89AttemptSchema.safeParse(parseJsonObjectText(row.attempt_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored attempt: ${parsed.error.message}`);
    const { result } = parsed.data;
    if (result === null) return [];
    const checks = result.checks.map((check) => ({ ...check, digest: null }));
    return [{ childRunId: row.child_run_id, json: JSON.stringify({ ...parsed.data, result: { ...result, checks } }) }];
  });
  const update = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of updates) update.run(row.json, row.childRunId);
}
