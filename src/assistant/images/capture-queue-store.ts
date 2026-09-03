import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { CaptureQueueState } from '../domain/enums.js';
import { CaptureQueueRowSchema, CountRowSchema, type CaptureQueueRow } from '../storage/rows.js';

/** States whose pixels are still on disk; byte accounting sees exactly these. */
const LIVE_CAPTURE_STATES = [
  'queued', 'awaiting_image_capability', 'processing', 'processed',
] as const satisfies readonly CaptureQueueState[];

/**
 * The subset retention may retire. `processing` is excluded because a worker is reading those
 * pixels right now: deleting the blob under it strands the extraction on a permanently missing
 * blob. They still count against the storage cap — the bytes are on disk either way.
 */
const RETIRABLE_CAPTURE_STATES = [
  'queued', 'awaiting_image_capability', 'processed',
] as const satisfies readonly CaptureQueueState[];

/** `processing` with no live extraction job: the worker that held it is gone. Binds `owner_id`. */
const STRANDED_PROCESSING_PREDICATE = `
  state = 'processing' AND evidence_id NOT IN (
    SELECT json_extract(payload_json, '$.evidenceId') FROM assistant_jobs
    WHERE owner_id = ? AND job_type = 'image_extraction'
      AND status IN ('queued', 'running', 'paused')
  )
`;

const LIVE_STATE_PLACEHOLDERS = LIVE_CAPTURE_STATES.map(() => '?').join(', ');
const RETIRABLE_STATE_PLACEHOLDERS = RETIRABLE_CAPTURE_STATES.map(() => '?').join(', ');

export interface EnqueueCaptureInput {
  readonly ownerId: string;
  readonly evidenceId: string;
  readonly state: CaptureQueueState;
  readonly foregroundContextKey: string;
  readonly pixelSha256: string;
  readonly perceptualHash: string;
  readonly byteLength: number;
}

/**
 * Row access for `assistant_capture_queue`. Dedupe lookups are always bounded by the caller's
 * retention window: once the pixels are gone, the hashes that described them stop deciding
 * anything (spec §4).
 */
export class CaptureQueueStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
  ) {}

  enqueue(input: EnqueueCaptureInput): CaptureQueueRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO assistant_capture_queue (
        evidence_id, owner_id, state, foreground_context_key, pixel_sha256, perceptual_hash,
        byte_length, enqueued_at_utc, processed_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      input.evidenceId, input.ownerId, input.state, input.foregroundContextKey,
      input.pixelSha256, input.perceptualHash, input.byteLength, nowUtc, nowUtc,
    );
    return this.require(input.evidenceId);
  }

  setState(evidenceId: string, state: CaptureQueueState): CaptureQueueRow {
    this.database
      .prepare('UPDATE assistant_capture_queue SET state = ?, updated_at_utc = ? WHERE evidence_id = ?')
      .run(state, this.clock.nowUtc(), evidenceId);
    return this.require(evidenceId);
  }

  markProcessed(evidenceId: string): CaptureQueueRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE assistant_capture_queue
      SET state = 'processed', processed_at_utc = ?, updated_at_utc = ? WHERE evidence_id = ?
    `).run(nowUtc, nowUtc, evidenceId);
    return this.require(evidenceId);
  }

  /** Oldest first: a stalled queue drains in the order the captures happened. */
  listByState(ownerId: string, state: CaptureQueueState, limit: number): CaptureQueueRow[] {
    return z.array(CaptureQueueRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_capture_queue
      WHERE owner_id = ? AND state = ?
      ORDER BY enqueued_at_utc ASC, evidence_id ASC LIMIT ?
    `).all(ownerId, state, limit));
  }

  countByState(ownerId: string, state: CaptureQueueState): number {
    return this.countInStates(ownerId, [state]);
  }

  /**
   * A capture is `processing` only while a worker holds it, so one with no live extraction job
   * has lost its worker to a crash, restart, or preemption. `PENDING_CAPTURE_STATES` does not
   * include `processing`, so without this the row would sit there unreachable until it expired.
   */
  recoverStrandedProcessing(ownerId: string): number {
    return this.database.prepare(`
      UPDATE assistant_capture_queue SET state = 'queued', updated_at_utc = ?
      WHERE owner_id = ? AND ${STRANDED_PROCESSING_PREDICATE}
    `).run(this.clock.nowUtc(), ownerId, ownerId).changes;
  }

  /** The same rows `recoverStrandedProcessing` would reset, for a caller that must inspect first. */
  listStrandedProcessing(ownerId: string): CaptureQueueRow[] {
    return z.array(CaptureQueueRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_capture_queue
      WHERE owner_id = ? AND ${STRANDED_PROCESSING_PREDICATE}
      ORDER BY enqueued_at_utc ASC, evidence_id ASC
    `).all(ownerId, ownerId));
  }

  /** One query regardless of how many states the caller aggregates over. */
  countInStates(ownerId: string, states: readonly CaptureQueueState[]): number {
    const placeholders = states.map(() => '?').join(', ');
    return CountRowSchema.parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_capture_queue
      WHERE owner_id = ? AND state IN (${placeholders})
    `).get(ownerId, ...states)).count;
  }

  /** Every capture retention may retire, in the order they arrived. Excludes `processing`. */
  listLiveOldestFirst(ownerId: string): CaptureQueueRow[] {
    return z.array(CaptureQueueRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_capture_queue
      WHERE owner_id = ? AND state IN (${RETIRABLE_STATE_PLACEHOLDERS})
      ORDER BY enqueued_at_utc ASC, evidence_id ASC
    `).all(ownerId, ...RETIRABLE_CAPTURE_STATES));
  }

  /** Bytes currently held by live captures, the number the storage cap is enforced against. */
  totalLiveBytes(ownerId: string): number {
    return CountRowSchema.parse(this.database.prepare(`
      SELECT COALESCE(SUM(byte_length), 0) AS count FROM assistant_capture_queue
      WHERE owner_id = ? AND state IN (${LIVE_STATE_PLACEHOLDERS})
    `).get(ownerId, ...LIVE_CAPTURE_STATES)).count;
  }

  get(evidenceId: string): CaptureQueueRow | null {
    const row = this.database
      .prepare('SELECT * FROM assistant_capture_queue WHERE evidence_id = ?')
      .get(evidenceId);
    return row === undefined || row === null ? null : CaptureQueueRowSchema.parse(row);
  }

  require(evidenceId: string): CaptureQueueRow {
    const row = this.get(evidenceId);
    if (row === null) {
      throw new Error(`Unknown capture queue entry: ${evidenceId}`);
    }
    return row;
  }

  findByPixelSha(ownerId: string, pixelSha256: string, sinceUtc: string): CaptureQueueRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_capture_queue
      WHERE owner_id = ? AND pixel_sha256 = ? AND enqueued_at_utc >= ?
      ORDER BY enqueued_at_utc DESC LIMIT 1
    `).get(ownerId, pixelSha256, sinceUtc);
    return row === undefined || row === null ? null : CaptureQueueRowSchema.parse(row);
  }

  listContextSince(
    ownerId: string, foregroundContextKey: string, sinceUtc: string,
  ): CaptureQueueRow[] {
    return z.array(CaptureQueueRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_capture_queue
      WHERE owner_id = ? AND foreground_context_key = ? AND enqueued_at_utc >= ?
      ORDER BY enqueued_at_utc DESC
    `).all(ownerId, foregroundContextKey, sinceUtc));
  }
}
