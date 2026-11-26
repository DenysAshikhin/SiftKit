import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const RunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
// Pins only what this step reads. A run that already has a summary was written by current code.
const Stored100RunSchema = z.object({
  phase: z.string(), parentRunIds: z.array(z.string()), summary: JsonValueSchema.optional(),
}).catchall(JsonValueSchema);
const LogRowSchema = z.object({ repo_search_json: z.string().nullable() }).optional();
const LogSchema = z.object({ scorecard: z.object({ tasks: z.array(z.object({ finalOutput: z.string() })) }) });
/** The finish may follow prose or sit in a fence. */
const FINISH_PATTERN = /\{\s*"status"[\s\S]*\}/u;
const FinishSchema = z.object({ status: z.literal('completed'), summary: z.string().trim().min(1) });

/** The accepted finish in the parent's log; logs are pruned, so many finished runs have none left. */
function loggedSummary(database: RuntimeDatabase, parentRunId: string): string | null {
  const row = LogRowSchema.parse(database.prepare('SELECT repo_search_json FROM run_logs WHERE run_id = ?').get(parentRunId));
  if (row === undefined || row.repo_search_json === null) return null;
  try {
    const { scorecard } = LogSchema.parse(parseJsonObjectText(row.repo_search_json));
    const [finish] = FINISH_PATTERN.exec(scorecard.tasks[0]?.finalOutput ?? '') ?? [];
    return finish === undefined ? null : FinishSchema.parse(parseJsonObjectText(finish)).summary;
  } catch {
    return null;
  }
}

/** Schema 100 -> 101: every stored run gains its summary; a completed one takes it from its log while that exists. */
export function upgradeOrchestratorRunSummary(database: RuntimeDatabase): void {
  const updateRun = database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?');
  for (const row of RunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const parsed = Stored100RunSchema.safeParse(parseJsonObjectText(row.state_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored state: ${parsed.error.message}`);
    const { phase, parentRunIds, summary } = parsed.data;
    const parentRunId = parentRunIds.at(-1);
    const recovered = phase === 'completed' && parentRunId !== undefined ? loggedSummary(database, parentRunId) : null;
    updateRun.run(JSON.stringify({ ...parsed.data, summary: summary ?? recovered }), row.run_id);
  }
}
