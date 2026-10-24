import { parseJsonValueText } from '../../lib/json.ts';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const AttemptRowsSchema = z.array(z.object({ child_run_id: z.string(), attempt_json: z.string() }));
// Pins only what this step reads from schema-84 attempt results.
const Stored84AgentReportSchema = z.object({
  kind: z.literal('agent'), criteria: z.array(z.object({ status: z.string() }).catchall(JsonValueSchema)),
  deviations: z.array(z.string()), discoveredNeeds: z.array(z.string()),
}).catchall(JsonValueSchema);
const Stored84ReportSchema = z.discriminatedUnion('kind', [
  Stored84AgentReportSchema, z.object({ kind: z.literal('search') }).catchall(JsonValueSchema),
]);
const Stored84ResultSchema = z.object({
  workerStatus: z.string(), outcome: z.string(), findings: z.array(z.string()), scopeViolations: z.array(z.string()),
  report: Stored84ReportSchema.nullable(),
}).catchall(JsonValueSchema);
const Stored84AttemptSchema = z.object({ result: Stored84ResultSchema.nullable() }).catchall(JsonValueSchema);

/** The long agent account becomes its status and deviations; work it found for other tasks is kept as deviations too. */
function upgradeReport(report: z.infer<typeof Stored84ReportSchema>): JsonObject {
  if (report.kind === 'search') return report;
  return {
    kind: 'agent', status: report.criteria.every((criterion) => criterion.status === 'met') ? 'completed' : 'incomplete',
    deviations: [
      ...report.deviations.map((what) => ({ what, why: 'Stated with the deviation in a schema-84 report.' })),
      ...report.discoveredNeeds.map((what) => ({ what, why: 'Work the child found for another task.' })),
    ],
  };
}

function upgradeResult(stored: z.infer<typeof Stored84ResultSchema>): JsonObject {
  const { scopeViolations, report, ...rest } = stored;
  const findings = rest.findings.filter((finding) => !scopeViolations.some((path) => finding === `Changed ${path}, which is outside the task's write scope.`));
  const result = { ...rest, findings, report: report === null ? null : upgradeReport(report) };
  // Scope was a scope-blocked attempt's only failure; its checks passed.
  return result.outcome === 'scope_blocked' ? { ...result, outcome: 'passed', passed: result.workerStatus === 'completed' } : result;
}

/** Schema 84 -> 85: write scope is guidance the orchestrator reviews, and an agent reports only its status and deviations. */
export function upgradeOrchestratorAttemptResults(database: RuntimeDatabase): void {
  const update = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of AttemptRowsSchema.parse(database.prepare('SELECT child_run_id, attempt_json FROM orchestrator_attempts').all())) {
    const attempt = Stored84AttemptSchema.parse(JsonObjectSchema.parse(parseJsonValueText(row.attempt_json)));
    if (attempt.result === null) continue;
    update.run(JSON.stringify({ ...attempt, result: upgradeResult(attempt.result) }), row.child_run_id);
  }
}
