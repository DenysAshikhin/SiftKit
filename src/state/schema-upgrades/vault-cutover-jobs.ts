import type { RuntimeDatabase } from '../database-handle.ts';

/** Job types the vault cutover retired; their rows would no longer parse, and their work is gone. */
const RETIRED_JOB_TYPES = [
  'conversation_ingestion', 'candidate_consolidation', 'projection_maintenance', 'question_answer_ingestion',
  'question_planning', 'projection_summarization', 'image_extraction',
] as const;

export function upgradeVaultCutoverJobs(database: RuntimeDatabase): void {
  database.prepare(`DELETE FROM assistant_jobs WHERE job_type IN (${RETIRED_JOB_TYPES.map(() => '?').join(', ')})`).run(...RETIRED_JOB_TYPES);
}
