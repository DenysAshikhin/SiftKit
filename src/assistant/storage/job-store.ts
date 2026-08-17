import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { JobStatus } from '../domain/enums.js';
import type { IdGenerator } from '../ids.js';
import {
  AssistantJobTypeSchema, CandidateConsolidationPayloadSchema,
  ConversationIngestionPayloadSchema, ProjectionMaintenancePayloadSchema,
  QuestionAnswerIngestionPayloadSchema,
  QuestionPlanningPayloadSchema, ProjectionSummarizationPayloadSchema,
  ImageExtractionPayloadSchema, CaptureRetentionPayloadSchema,
  type AssistantJobType, type CandidateConsolidationPayload,
  type ConversationIngestionPayload, type ProjectionMaintenancePayload,
  type QuestionAnswerIngestionPayload,
  type QuestionPlanningPayload, type ProjectionSummarizationPayload,
  type ImageExtractionPayload, type CaptureRetentionPayload,
} from '../jobs/job-types.js';
import { IdRowSchema, JobRowSchema, type JobRow } from './rows.js';

export interface EnqueueJobInput {
  readonly ownerId: string;
  readonly jobType: AssistantJobType;
  readonly payload: JsonObject;
  readonly idempotencyKey: string;
}

export interface ClaimJobInput {
  readonly ownerId: string;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
  readonly modelWorkAllowed: boolean;
}

/** Each retry waits this many seconds times the attempts already consumed. */
const RETRY_BACKOFF_SECONDS = 30;

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Owns `assistant_jobs`. Claiming is a single conditional update so two runners can never hold
 * one job, and `attempts` is consumed at claim time so a crash loop terminates (§12.2).
 */
export class JobStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Returns `null` when an equivalent job is already live — a replayed enqueue is a no-op. */
  enqueue(input: EnqueueJobInput, priority: number): JobRow | null {
    if (!Number.isInteger(priority)) {
      throw new Error(`Assistant job priority must be an integer; received ${priority}.`);
    }
    if (this.findLiveByIdempotencyKey(input.ownerId, input.idempotencyKey) !== null) {
      return null;
    }
    const id = this.ids.next('job');
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO assistant_jobs (
        id, owner_id, job_type, priority, payload_json, idempotency_key, status,
        attempts, max_attempts, available_at_utc, lease_owner, lease_expires_at_utc,
        last_error, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id, input.ownerId, AssistantJobTypeSchema.parse(input.jobType), priority,
      JSON.stringify(input.payload), input.idempotencyKey, DEFAULT_MAX_ATTEMPTS,
      nowUtc, nowUtc, nowUtc,
    );
    return this.requireJob(id);
  }

  claimNext(input: ClaimJobInput): JobRow | null {
    const nowUtc = this.clock.nowUtc();
    const candidate = this.database.prepare(`
      SELECT id FROM assistant_jobs
      WHERE owner_id = ? AND status = 'queued' AND available_at_utc <= ?
        AND (? = 1 OR job_type NOT IN (
          'conversation_ingestion', 'candidate_consolidation', 'question_planning',
          'question_answer_ingestion', 'projection_summarization'
        ))
      ORDER BY priority DESC, available_at_utc ASC, created_at_utc ASC, id ASC
      LIMIT 1
    `).get(input.ownerId, nowUtc, input.modelWorkAllowed ? 1 : 0);
    if (candidate === undefined || candidate === null) {
      return null;
    }
    const jobId = IdRowSchema.parse(candidate).id;
    const leaseExpiresAtUtc =
      new Date(this.clock.nowEpochMs() + input.leaseSeconds * 1000).toISOString();
    const updated = this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'running', attempts = attempts + 1, lease_owner = ?,
          lease_expires_at_utc = ?, updated_at_utc = ?
      WHERE id = ? AND status = 'queued'
    `).run(input.leaseOwner, leaseExpiresAtUtc, nowUtc, jobId);
    return updated.changes === 1 ? this.requireJob(jobId) : null;
  }

  complete(jobId: string): JobRow {
    this.setTerminal(jobId, 'completed', null);
    return this.requireJob(jobId);
  }

  cancel(jobId: string): JobRow {
    this.setTerminal(jobId, 'cancelled', null);
    return this.requireJob(jobId);
  }

  /** Re-queues with backoff, or dead-letters once the attempt budget is spent. */
  fail(jobId: string, errorMessage: string): JobRow {
    const job = this.requireJob(jobId);
    if (job.attempts >= job.max_attempts) {
      this.setTerminal(jobId, 'dead_letter', errorMessage);
      return this.requireJob(jobId);
    }
    const availableAtUtc = new Date(
      this.clock.nowEpochMs() + job.attempts * RETRY_BACKOFF_SECONDS * 1000,
    ).toISOString();
    this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'queued', lease_owner = NULL, lease_expires_at_utc = NULL,
          available_at_utc = ?, last_error = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(availableAtUtc, errorMessage, this.clock.nowUtc(), jobId);
    return this.requireJob(jobId);
  }

  /** Preemption is not failure (§12.3): the attempt this claim consumed is given back. */
  requeuePreempted(jobId: string): JobRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'queued', attempts = MAX(attempts - 1, 0), lease_owner = NULL,
          lease_expires_at_utc = NULL, available_at_utc = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(nowUtc, nowUtc, jobId);
    return this.requireJob(jobId);
  }

  /** Returns how many expired-lease jobs were returned to the queue. */
  recoverExpiredLeases(ownerId: string): number {
    const nowUtc = this.clock.nowUtc();
    const result = this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'queued', lease_owner = NULL, lease_expires_at_utc = NULL,
          available_at_utc = ?, updated_at_utc = ?
      WHERE owner_id = ? AND status = 'running' AND lease_expires_at_utc < ?
    `).run(nowUtc, nowUtc, ownerId, nowUtc);
    return result.changes;
  }

  /** Deletes terminal jobs last touched before the cutoff. Live jobs are never touched. */
  pruneTerminal(ownerId: string, beforeUtc: string): number {
    const result = this.database.prepare(`
      DELETE FROM assistant_jobs
      WHERE owner_id = ? AND status IN ('completed', 'failed', 'cancelled', 'dead_letter')
        AND updated_at_utc < ?
    `).run(ownerId, beforeUtc);
    return result.changes;
  }

  getJob(jobId: string): JobRow | null {
    const row = this.database.prepare('SELECT * FROM assistant_jobs WHERE id = ?').get(jobId);
    return row === undefined || row === null ? null : JobRowSchema.parse(row);
  }

  requireJob(jobId: string): JobRow {
    const row = this.getJob(jobId);
    if (row === null) {
      throw new Error(`Unknown assistant job: ${jobId}`);
    }
    return row;
  }

  listByStatus(ownerId: string, status: JobStatus): JobRow[] {
    return z.array(JobRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_jobs WHERE owner_id = ? AND status = ?
      ORDER BY priority DESC, created_at_utc ASC, id ASC
    `).all(ownerId, status));
  }

  countByStatus(ownerId: string, status: JobStatus): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_jobs WHERE owner_id = ? AND status = ?
    `).get(ownerId, status)).count;
  }

  readConversationPayload(job: JobRow): ConversationIngestionPayload {
    this.requireJobType(job, 'conversation_ingestion');
    return parseJsonText(job.payload_json, ConversationIngestionPayloadSchema);
  }

  readConsolidationPayload(job: JobRow): CandidateConsolidationPayload {
    this.requireJobType(job, 'candidate_consolidation');
    return parseJsonText(job.payload_json, CandidateConsolidationPayloadSchema);
  }

  readProjectionPayload(job: JobRow): ProjectionMaintenancePayload {
    this.requireJobType(job, 'projection_maintenance');
    return parseJsonText(job.payload_json, ProjectionMaintenancePayloadSchema);
  }

  readQuestionAnswerPayload(job: JobRow): QuestionAnswerIngestionPayload {
    this.requireJobType(job, 'question_answer_ingestion');
    return parseJsonText(job.payload_json, QuestionAnswerIngestionPayloadSchema);
  }

  readQuestionPlanningPayload(job: JobRow): QuestionPlanningPayload {
    this.requireJobType(job, 'question_planning');
    return parseJsonText(job.payload_json, QuestionPlanningPayloadSchema);
  }

  readProjectionSummarizationPayload(job: JobRow): ProjectionSummarizationPayload {
    this.requireJobType(job, 'projection_summarization');
    return parseJsonText(job.payload_json, ProjectionSummarizationPayloadSchema);
  }

  readImageExtractionPayload(job: JobRow): ImageExtractionPayload {
    this.requireJobType(job, 'image_extraction');
    return parseJsonText(job.payload_json, ImageExtractionPayloadSchema);
  }

  readCaptureRetentionPayload(job: JobRow): CaptureRetentionPayload {
    this.requireJobType(job, 'capture_retention');
    return parseJsonText(job.payload_json, CaptureRetentionPayloadSchema);
  }

  private requireJobType(job: JobRow, expected: AssistantJobType): void {
    if (AssistantJobTypeSchema.parse(job.job_type) !== expected) {
      throw new Error(`Job ${job.id} is ${job.job_type}, not ${expected}.`);
    }
  }

  private findLiveByIdempotencyKey(ownerId: string, idempotencyKey: string): JobRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_jobs
      WHERE owner_id = ? AND idempotency_key = ? AND status IN ('queued', 'running', 'paused')
    `).get(ownerId, idempotencyKey);
    return row === undefined || row === null ? null : JobRowSchema.parse(row);
  }

  private setTerminal(jobId: string, status: JobStatus, errorMessage: string | null): void {
    this.database.prepare(`
      UPDATE assistant_jobs
      SET status = ?, lease_owner = NULL, lease_expires_at_utc = NULL,
          last_error = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(status, errorMessage, this.clock.nowUtc(), jobId);
  }
}
