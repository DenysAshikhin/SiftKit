import { LIVE_JOB_STATUSES } from '../../assistant/domain/enums.ts';
import { AssistantJobRequestSchema, jobIdempotencyKey } from '../../assistant/jobs/job-types.ts';
import { parseJsonObjectText } from '../../lib/json.ts';
import { z } from '../../lib/zod.ts';
import { syncFactPoints } from '../../vault/fact-points.ts';
import { markRollupDay } from '../../vault/rollup-days.ts';
import { VAULT_VALIDATION_TABLES_SQL } from '../../vault/vault-schema.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const ColumnNameRowsSchema = z.array(z.object({ name: z.string() }));
const NoteRowsSchema = z.array(z.object({ id: z.string(), body: z.string(), updated_at_utc: z.string() }));
const TIMESTAMP_COLUMNS = ['last_accessed_at_utc', 'validated_at_utc'] as const;
const JobPayloadRowsSchema = z.array(z.object({ id: z.string(), payload_json: z.string() }));
const LIVE_JOBS = `status IN (${LIVE_JOB_STATUSES.map((status) => `'${status}'`).join(', ')})`;
const RETIRED_JOB_TYPES = "'chat_note', 'capture_note', 'daily_rollup', 'note_tidy', 'capture_retention'";

/** Schema 87 -> 88: note and fact-value timestamps, backfilled so the whole vault enters the validation queue. */
export function upgradeVaultValidation(database: RuntimeDatabase): void {
  const columns = ColumnNameRowsSchema.parse(database.prepare('SELECT name FROM pragma_table_info(?)').all('vault_notes')).map((row) => row.name);
  if (columns.length === 0) throw new Error('Schema 87 is missing vault_notes; cannot add validation timestamps.');
  for (const column of TIMESTAMP_COLUMNS) {
    if (!columns.includes(column)) database.exec(`ALTER TABLE vault_notes ADD COLUMN ${column} TEXT`);
  }
  database.exec(VAULT_VALIDATION_TABLES_SQL);
  for (const note of NoteRowsSchema.parse(database.prepare('SELECT id, body, updated_at_utc FROM vault_notes').all())) {
    syncFactPoints(database, note.id, note.body, note.updated_at_utc);
  }
  convertRetiredJobs(database);
}

/** Live chat turns become chat writes and pending rollups become rollup days; the rest re-derive on the next drain. */
function convertRetiredJobs(database: RuntimeDatabase): void {
  const convert = database.prepare("UPDATE assistant_jobs SET job_type = 'vault_write', payload_json = ?, idempotency_key = ? WHERE id = ?");
  for (const job of JobPayloadRowsSchema.parse(database.prepare(`SELECT id, payload_json FROM assistant_jobs WHERE job_type = 'chat_note' AND ${LIVE_JOBS}`).all())) {
    const request = AssistantJobRequestSchema.parse({ jobType: 'vault_write', payload: { source: 'chat', turn: parseJsonObjectText(job.payload_json) } });
    convert.run(JSON.stringify(request.payload), jobIdempotencyKey(request), job.id);
  }
  for (const job of JobPayloadRowsSchema.parse(database.prepare(`SELECT id, payload_json FROM assistant_jobs WHERE job_type = 'daily_rollup' AND ${LIVE_JOBS}`).all())) {
    markRollupDay(database, z.object({ day: z.string() }).parse(parseJsonObjectText(job.payload_json)).day);
  }
  database.prepare(`DELETE FROM assistant_jobs WHERE job_type IN (${RETIRED_JOB_TYPES})`).run();
}
