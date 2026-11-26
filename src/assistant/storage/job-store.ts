import { z } from '../../lib/zod.ts';
import { parseJsonObjectText } from '../../lib/json.ts';
import type { AssistantConfig } from '../../config/types.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import type { Clock } from '../clock.ts';
import { LIVE_JOB_STATUSES, type JobStatus } from '../domain/enums.ts';
import type { IdGenerator } from '../ids.ts';
import {
  AssistantJobRequestSchema, MODEL_BACKED_JOB_TYPE, jobIdempotencyKey, jobPriority, type AssistantJobRequest, type AssistantJobType,
} from '../jobs/job-types.ts';
import { IdRowSchema, JobRowSchema, type JobRow } from './rows.ts';

export interface ClaimJobInput {
  readonly ownerId: string;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
  readonly modelWorkAllowed: boolean;
}

/** Each retry waits this many seconds times the attempts already consumed. */
const RETRY_BACKOFF_SECONDS = 30;

const DEFAULT_MAX_ATTEMPTS = 3;

const SET_TERMINAL_SQL = `
  UPDATE assistant_jobs
  SET status = ?, lease_owner = NULL, lease_expires_at_utc = NULL, last_error = ?, updated_at_utc = ?
  WHERE id = ?`;

/**
 * Owns `assistant_jobs`. Claiming is a single conditional update so two runners can never hold
 * one job, and `attempts` is consumed at claim time so a crash loop terminates (§12.2).
 */
export class JobStore {
  private readonly database: RuntimeDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    database: RuntimeDatabase,
    clock: Clock,
    ids: IdGenerator,
  ) {
    this.database = database;
    this.clock = clock;
    this.ids = ids;
  }

  /** Validates the request and keys it by its payload; `null` when the same work is already live. */
  enqueue(ownerId: string, request: AssistantJobRequest, priorities: AssistantConfig['Background']['JobPriorities']): JobRow | null {
    const parsed = AssistantJobRequestSchema.parse(request);
    const { jobType, payload } = parsed;
    const priority = jobPriority(priorities, parsed);
    if (!Number.isInteger(priority)) {
      throw new Error(`Assistant job priority must be an integer; received ${priority}.`);
    }
    const idempotencyKey = jobIdempotencyKey(parsed);
    if (this.findLiveByIdempotencyKey(ownerId, idempotencyKey) !== null) {
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
      id, ownerId, jobType, priority, JSON.stringify(payload), idempotencyKey, DEFAULT_MAX_ATTEMPTS,
      nowUtc, nowUtc, nowUtc,
    );
    return this.requireJob(id);
  }

  claimNext(input: ClaimJobInput): JobRow | null {
    const nowUtc = this.clock.nowUtc();
    const candidate = this.database.prepare(`
      SELECT id FROM assistant_jobs
      WHERE owner_id = ? AND status = 'queued' AND available_at_utc <= ?
        AND (? = 1 OR job_type != ?)
      ORDER BY priority DESC, available_at_utc ASC, created_at_utc ASC, id ASC
      LIMIT 1
    `).get(
      input.ownerId,
      nowUtc,
      input.modelWorkAllowed ? 1 : 0,
      MODEL_BACKED_JOB_TYPE,
    );
    if (candidate === undefined || candidate === null) {
      return null;
    }
    return this.lease(IdRowSchema.parse(candidate).id, input);
  }

  /** Claims one named queued job regardless of its retry backoff; `null` when it is not queued. */
  claimById(ownerId: string, jobId: string, input: Omit<ClaimJobInput, 'ownerId' | 'modelWorkAllowed'>): JobRow | null {
    const job = this.getJob(jobId);
    return job !== null && job.owner_id === ownerId ? this.lease(jobId, input) : null;
  }

  private lease(jobId: string, input: Omit<ClaimJobInput, 'ownerId' | 'modelWorkAllowed'>): JobRow | null {
    const leaseExpiresAtUtc =
      new Date(this.clock.nowEpochMs() + input.leaseSeconds * 1000).toISOString();
    const updated = this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'running', attempts = attempts + 1, lease_owner = ?,
          lease_expires_at_utc = ?, updated_at_utc = ?
      WHERE id = ? AND status = 'queued'
    `).run(input.leaseOwner, leaseExpiresAtUtc, this.clock.nowUtc(), jobId);
    return updated.changes === 1 ? this.requireJob(jobId) : null;
  }

  /** Finishes the claim; `null` when the lease was lost and another runner owns the job now. */
  complete(jobId: string, leaseOwner: string): JobRow | null {
    return this.setTerminal(jobId, leaseOwner, 'completed', null);
  }

  /** User intent beats a lease: a queued job (lease_owner NULL) must stay cancellable. */
  cancel(jobId: string): JobRow {
    this.database.prepare(SET_TERMINAL_SQL).run('cancelled', null, this.clock.nowUtc(), jobId);
    return this.requireJob(jobId);
  }

  /** Re-queues with backoff, or dead-letters once the attempt budget is spent; `null` on a lost lease. */
  fail(jobId: string, leaseOwner: string, errorMessage: string): JobRow | null {
    const job = this.requireJob(jobId);
    if (job.attempts >= job.max_attempts) {
      return this.setTerminal(jobId, leaseOwner, 'dead_letter', errorMessage);
    }
    const availableAtUtc = new Date(
      this.clock.nowEpochMs() + job.attempts * RETRY_BACKOFF_SECONDS * 1000,
    ).toISOString();
    const updated = this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'queued', lease_owner = NULL, lease_expires_at_utc = NULL,
          available_at_utc = ?, last_error = ?, updated_at_utc = ?
      WHERE id = ? AND lease_owner = ?
    `).run(availableAtUtc, errorMessage, this.clock.nowUtc(), jobId, leaseOwner);
    return updated.changes === 1 ? this.requireJob(jobId) : null;
  }

  /** Preemption is not failure (§12.3): the attempt this claim consumed is given back; `null` on a lost lease. */
  requeuePreempted(jobId: string, leaseOwner: string): JobRow | null {
    const nowUtc = this.clock.nowUtc();
    const updated = this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'queued', attempts = MAX(attempts - 1, 0), lease_owner = NULL,
          lease_expires_at_utc = NULL, available_at_utc = ?, updated_at_utc = ?
      WHERE id = ? AND lease_owner = ?
    `).run(nowUtc, nowUtc, jobId, leaseOwner);
    return updated.changes === 1 ? this.requireJob(jobId) : null;
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

  /** Attachment ids with a capture write still queued, running, or paused. Payloads are parsed. */
  listLiveCaptureWriteAttachmentIds(ownerId: string): string[] {
    return LIVE_JOB_STATUSES.flatMap((status) => this.listByStatus(ownerId, status))
      .map((job) => this.readRequest(job))
      .flatMap((request) => (request.jobType === 'vault_write' && request.payload.source === 'capture' ? [request.payload.attachmentId] : []));
  }

  countQueued(ownerId: string, jobType: AssistantJobType): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_jobs WHERE owner_id = ? AND job_type = ? AND status = 'queued'
    `).get(ownerId, jobType)).count;
  }

  countByStatus(ownerId: string, status: JobStatus): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_jobs WHERE owner_id = ? AND status = ?
    `).get(ownerId, status)).count;
  }

  /** The request a stored job was enqueued with; a payload that no longer fits its type throws. */
  readRequest(job: JobRow): AssistantJobRequest {
    return AssistantJobRequestSchema.parse({ jobType: job.job_type, payload: parseJsonObjectText(job.payload_json) });
  }

  private findLiveByIdempotencyKey(ownerId: string, idempotencyKey: string): JobRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_jobs
      WHERE owner_id = ? AND idempotency_key = ? AND status IN ('queued', 'running', 'paused')
    `).get(ownerId, idempotencyKey);
    return row === undefined || row === null ? null : JobRowSchema.parse(row);
  }

  /**
   * Terminal writes are fenced by the claim's lease owner, so a job re-claimed after a lapsed
   * lease keeps the live runner's outcome; a lost lease changes zero rows and yields null.
   */
  private setTerminal(jobId: string, leaseOwner: string, status: JobStatus, errorMessage: string | null): JobRow | null {
    const updated = this.database.prepare(`${SET_TERMINAL_SQL} AND lease_owner = ?`).run(
      status, errorMessage, this.clock.nowUtc(), jobId, leaseOwner,
    );
    return updated.changes === 1 ? this.requireJob(jobId) : null;
  }
}
