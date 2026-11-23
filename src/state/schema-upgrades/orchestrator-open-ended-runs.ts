import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const RunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
// Pins only what this step reads from a schema-97 run. A row that already has `approaches` was written by current code.
const Stored97RunSchema = z.object({
  request: z.object({}).catchall(JsonValueSchema),
  plan: z.object({}).catchall(JsonValueSchema).nullable(),
  tasks: z.array(z.object({ taskId: z.string() }).catchall(JsonValueSchema)),
  failure: z.object({ code: z.string() }).catchall(JsonValueSchema).nullable(),
  createdAtUtc: z.string(),
  approaches: z.array(JsonValueSchema).optional(),
}).catchall(JsonValueSchema);

// Literals, so a later change to the defaults cannot change what this upgrade writes.
const BUDGET_98 = { minutes: 720, dispatches: 80 };
const FIRST_APPROACH_TITLE_98 = 'Initial plan';

/**
 * Schema 97 -> 98: every run gains a budget, its approaches, and its retired tasks; each task names approach 1.
 * A run that failed on the old finish limit failed on a spent budget.
 */
export function upgradeOrchestratorOpenEndedRuns(database: RuntimeDatabase): void {
  const update = database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?');
  for (const row of RunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const parsed = Stored97RunSchema.safeParse(parseJsonObjectText(row.state_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored state: ${parsed.error.message}`);
    const run = parsed.data;
    if (run.approaches !== undefined) continue;
    const failure = run.failure === null ? null
      : { ...run.failure, code: run.failure.code === 'final_verification_failed' ? 'budget_exhausted' : run.failure.code };
    update.run(JSON.stringify({
      ...run, failure,
      request: { ...run.request, budget: BUDGET_98 },
      tasks: run.tasks.map((task) => ({ ...task, approach: 1 })),
      approaches: run.plan === null ? [] : [{ number: 1, title: FIRST_APPROACH_TITLE_98, startedAtUtc: run.createdAtUtc, outcome: null }],
      retiredTasks: [],
    }), row.run_id);
  }
}
