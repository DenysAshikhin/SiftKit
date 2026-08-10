import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { CaptureQueueState } from '../domain/enums.js';
import { CaptureQueueRowSchema, type CaptureQueueRow } from '../storage/rows.js';

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
