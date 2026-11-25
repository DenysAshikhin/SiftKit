import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const RunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
const AttemptRowsSchema = z.array(z.object({ child_run_id: z.string(), attempt_json: z.string() }));
// Pins only what this step reads. A task or run that already has the new field was written by current code.
const Stored98TaskSchema = z.object({ why: JsonValueSchema.optional() }).catchall(JsonValueSchema);
const Stored98RunSchema = z.object({
  plan: z.object({ tasks: z.array(Stored98TaskSchema) }).catchall(JsonValueSchema).nullable(),
  statusLines: JsonValueSchema.optional(),
}).catchall(JsonValueSchema);
const Stored98AttemptSchema = z.object({
  work: z.object({ task: Stored98TaskSchema }).catchall(JsonValueSchema),
}).catchall(JsonValueSchema);

function withWhy(task: z.infer<typeof Stored98TaskSchema>) {
  return { ...task, why: task.why ?? null };
}

/** Schema 98 -> 99: every stored copy of a plan task gains `why`, and every run its run-wide lines. */
export function upgradeOrchestratorTaskPurpose(database: RuntimeDatabase): void {
  const updateRun = database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?');
  for (const row of RunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const parsed = Stored98RunSchema.safeParse(parseJsonObjectText(row.state_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored state: ${parsed.error.message}`);
    const { plan } = parsed.data;
    updateRun.run(JSON.stringify({
      ...parsed.data, statusLines: parsed.data.statusLines ?? [],
      plan: plan === null ? null : { ...plan, tasks: plan.tasks.map(withWhy) },
    }), row.run_id);
  }
  const updateAttempt = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of AttemptRowsSchema.parse(database.prepare('SELECT child_run_id, attempt_json FROM orchestrator_attempts').all())) {
    const parsed = Stored98AttemptSchema.safeParse(parseJsonObjectText(row.attempt_json));
    if (!parsed.success) throw new Error(`Orchestrator attempt ${row.child_run_id} has an unreadable stored state: ${parsed.error.message}`);
    const { work } = parsed.data;
    updateAttempt.run(JSON.stringify({ ...parsed.data, work: { ...work, task: withWhy(work.task) } }), row.child_run_id);
  }
}
