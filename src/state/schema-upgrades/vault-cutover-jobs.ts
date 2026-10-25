import type { RuntimeDatabase } from '../database-handle.ts';

/**
 * Job types the vault cutover retired, plus `capture_retention`, whose payload lost its `reason`.
 * None of their rows would parse; the next drain re-enqueues retention in the new shape.
 */
const LEGACY_JOB_TYPES = [
  'conversation_ingestion', 'candidate_consolidation', 'projection_maintenance', 'question_answer_ingestion',
  'question_planning', 'projection_summarization', 'image_extraction', 'capture_retention',
] as const;

export function upgradeVaultCutoverJobs(database: RuntimeDatabase): void {
  database.prepare(`DELETE FROM assistant_jobs WHERE job_type IN (${LEGACY_JOB_TYPES.map(() => '?').join(', ')})`).run(...LEGACY_JOB_TYPES);
}
