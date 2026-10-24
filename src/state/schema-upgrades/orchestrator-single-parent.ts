import { parseJsonValueText } from '../../lib/json.ts';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const RunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
const AttemptRowsSchema = z.array(z.object({
  run_id: z.string(), task_id: z.string(), purpose: z.string(), attempt: z.number().int(), child_run_id: z.string(), attempt_json: z.string(),
}));
const EventRowsSchema = z.array(z.object({ run_id: z.string(), sequence: z.number().int(), event_json: z.string() }));

// Pins only what this step reads from schema-83 rows.
const PlanTaskSchema = z.object({ id: z.string(), title: z.string() }).catchall(JsonValueSchema);
const Stored83RunSchema = z.object({
  phase: z.string(), phaseRunIds: z.array(z.string()),
  planPath: z.string().nullable(), planHash: z.string().nullable(),
  plan: z.object({ tasks: z.array(PlanTaskSchema) }).catchall(JsonValueSchema).nullable(),
  tasks: z.array(z.object({ taskId: z.string(), status: z.string() }).catchall(JsonValueSchema)),
  failure: z.object({ code: z.string(), message: z.string(), taskId: z.string().nullable() }).catchall(JsonValueSchema).nullable(),
}).catchall(JsonValueSchema);
const DriftFindingSchema = z.object({ id: z.string(), title: z.string(), fix: z.string() }).catchall(JsonValueSchema);
const Stored83WorkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('implementation'), task: PlanTaskSchema }).catchall(JsonValueSchema),
  z.object({ kind: z.literal('drift_fix'), taskId: z.string(), objective: z.string(), findings: z.array(DriftFindingSchema),
    allowedPaths: z.array(z.string()), verification: z.array(JsonObjectSchema) }).catchall(JsonValueSchema),
]);
const Stored83AttemptSchema = z.object({
  purpose: z.string(), work: Stored83WorkSchema,
  result: z.object({ purpose: z.string(), workerStatus: z.string(), passed: z.boolean() }).catchall(JsonValueSchema).nullable(),
}).catchall(JsonValueSchema);

/** Open statuses keep meaning open work, so startup still interrupts them; terminal ones are unchanged. */
const TASK_STATUSES: Record<string, string> = {
  verifying: 'running', correcting_drift: 'running', retry_pending: 'reviewing', reviewing_drift: 'reviewing',
};
/** Phase and answer failures of the retired phases become the orchestrator's own stops; their messages keep the detail. */
const FAILURE_CODES: Record<string, string> = {
  plan_blocked: 'blocked', plan_invalid: 'blocked', implementation_failed: 'blocked', drift_unresolved: 'blocked',
  task_review_invalid: 'orchestrator_incomplete', drift_review_invalid: 'orchestrator_incomplete',
  approval_decision_invalid: 'orchestrator_incomplete', final_review_invalid: 'orchestrator_incomplete',
};

function purposeOf(purpose: string): string {
  return purpose === 'drift_fix' ? 'fix' : purpose;
}

function upgradeRun(state: JsonObject): JsonObject {
  const run = Stored83RunSchema.parse(state);
  const { phaseRunIds, failure, ...rest } = run;
  return {
    ...rest,
    phase: run.phase === 'validating_plan' ? 'preparing_plan' : run.phase,
    parentRunIds: phaseRunIds,
    tasks: run.tasks.map((task) => ({ taskId: task.taskId, status: TASK_STATUSES[task.status] ?? task.status, review: null })),
    failure: failure === null ? null : { code: FAILURE_CODES[failure.code] ?? failure.code, message: failure.message, taskId: failure.taskId },
  };
}

/** A drift correction becomes a fix of its plan task, scoped and checked as it was, with its findings as the instruction. */
function upgradeWork(work: z.infer<typeof Stored83WorkSchema>, run: z.infer<typeof Stored83RunSchema>): JsonObject {
  if (work.kind === 'implementation') {
    return { ...work, instruction: `Implement task '${work.task.id}' — ${work.task.title} — as the plan states.` };
  }
  const task = run.plan?.tasks.find((entry) => entry.id === work.taskId);
  if (task === undefined || run.planPath === null || run.planHash === null) {
    throw new Error(`Schema 83 drift correction for task '${work.taskId}' has no saved plan task; cannot upgrade it.`);
  }
  return {
    kind: 'fix', planPath: run.planPath, planHash: run.planHash,
    task: { ...task, writePaths: work.allowedPaths, verification: work.verification },
    instruction: [work.objective, ...work.findings.map((finding) => `- ${finding.id}: ${finding.title} (fix: ${finding.fix})`)].join('\n'),
  };
}

function upgradeAttempt(attempt: JsonObject, run: z.infer<typeof Stored83RunSchema>): JsonObject {
  const stored = Stored83AttemptSchema.parse(attempt);
  const result = stored.result;
  return {
    ...attempt, purpose: purposeOf(stored.purpose), work: upgradeWork(stored.work, run),
    result: result === null ? null : {
      ...result, purpose: purposeOf(result.purpose), report: null, submissions: result.workerStatus === 'completed' ? 1 : 0,
      outcome: result.passed ? 'passed' : result.workerStatus === 'completed' ? 'checks_failed' : 'not_submitted',
    },
  };
}

function upgradeEvent(event: JsonObject): JsonObject {
  return {
    ...event,
    phase: event.phase === 'validating_plan' ? 'preparing_plan' : event.phase ?? null,
    purpose: event.purpose === 'drift_fix' ? 'fix' : event.purpose ?? null,
  };
}

/**
 * Schema 83 -> 84: one persistent orchestrator replaces the phase state machine. Drift corrections become
 * fixes, drift reviews give way to the orchestrator's task reviews, and the parent's phase runs become its
 * conversation runs. The attempts table is rebuilt because its purpose CHECK names the retired purpose.
 */
export function upgradeOrchestratorSingleParent(database: RuntimeDatabase): void {
  const runs = new Map<string, z.infer<typeof Stored83RunSchema>>();
  const updateRun = database.prepare('UPDATE orchestrator_runs SET state_json = ?, phase = ? WHERE run_id = ?');
  for (const row of RunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const state = JsonObjectSchema.parse(parseJsonValueText(row.state_json));
    runs.set(row.run_id, Stored83RunSchema.parse(state));
    const upgraded = upgradeRun(state);
    updateRun.run(JSON.stringify(upgraded), String(upgraded.phase), row.run_id);
  }
  const attempts = AttemptRowsSchema.parse(database.prepare(
    'SELECT run_id, task_id, purpose, attempt, child_run_id, attempt_json FROM orchestrator_attempts ORDER BY rowid',
  ).all());
  database.exec(`
    CREATE TABLE orchestrator_attempts_84 (
      run_id TEXT NOT NULL REFERENCES orchestrator_runs(run_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('implementation', 'fix')),
      attempt INTEGER NOT NULL CHECK (attempt IN (1, 2)),
      child_run_id TEXT NOT NULL UNIQUE,
      attempt_json TEXT NOT NULL,
      PRIMARY KEY (run_id, task_id, purpose, attempt)
    );
  `);
  const insert = database.prepare(
    'INSERT INTO orchestrator_attempts_84 (run_id, task_id, purpose, attempt, child_run_id, attempt_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const row of attempts) {
    const run = runs.get(row.run_id);
    if (run === undefined) throw new Error(`Schema 83 attempt ${row.child_run_id} names unknown run ${row.run_id}.`);
    const upgraded = upgradeAttempt(JsonObjectSchema.parse(parseJsonValueText(row.attempt_json)), run);
    insert.run(row.run_id, row.task_id, purposeOf(row.purpose), row.attempt, row.child_run_id, JSON.stringify(upgraded));
  }
  database.exec('DROP TABLE orchestrator_attempts; ALTER TABLE orchestrator_attempts_84 RENAME TO orchestrator_attempts;');
  const updateEvent = database.prepare('UPDATE orchestrator_events SET event_json = ? WHERE run_id = ? AND sequence = ?');
  for (const row of EventRowsSchema.parse(database.prepare('SELECT run_id, sequence, event_json FROM orchestrator_events').all())) {
    updateEvent.run(JSON.stringify(upgradeEvent(JsonObjectSchema.parse(parseJsonValueText(row.event_json)))), row.run_id, row.sequence);
  }
}
