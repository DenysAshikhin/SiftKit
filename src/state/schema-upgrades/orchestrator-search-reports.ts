import { parseJsonValueText } from '../../lib/json.ts';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const AttemptRowsSchema = z.array(z.object({ child_run_id: z.string(), attempt_json: z.string() }));
// Pins only what this step reads from schema-85 search reports.
const Stored85SearchReportSchema = z.object({
  kind: z.literal('search'), findings: z.array(z.object({}).catchall(JsonValueSchema)),
}).catchall(JsonValueSchema);
const Stored85AttemptSchema = z.object({
  result: z.object({ report: z.object({ kind: z.string() }).catchall(JsonValueSchema).nullable() }).catchall(JsonValueSchema).nullable(),
}).catchall(JsonValueSchema);

function upgradeSearchReport(report: z.infer<typeof Stored85SearchReportSchema>): JsonObject {
  const { understood: _understood, findings, ...rest } = report;
  return { ...rest, findings: findings.map(({ confidence: _confidence, ...finding }) => finding) };
}

/** Schema 85 -> 86: a search report is its anchored findings and unknowns, without a restated question or confidence grades. */
export function upgradeOrchestratorSearchReports(database: RuntimeDatabase): void {
  const update = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of AttemptRowsSchema.parse(database.prepare('SELECT child_run_id, attempt_json FROM orchestrator_attempts').all())) {
    const attempt = Stored85AttemptSchema.parse(JsonObjectSchema.parse(parseJsonValueText(row.attempt_json)));
    const report = attempt.result?.report;
    if (attempt.result === null || report?.kind !== 'search') continue;
    const result = { ...attempt.result, report: upgradeSearchReport(Stored85SearchReportSchema.parse(report)) };
    update.run(JSON.stringify({ ...attempt, result }), row.child_run_id);
  }
}
