import type { AssistantConfig } from '../../config/types.js';
import type { AssistantGraph } from '../assistant-graph.js';
import type { Clock } from '../clock.js';
import type { CaptureRetentionPayload } from '../jobs/job-types.js';
import type { CaptureQueueRow } from '../storage/rows.js';
import type { CaptureQueueStore } from './capture-queue-store.js';

const BYTES_PER_GB = 1024 ** 3;

/** The raw-storage cap in bytes; intake and retention must agree on this conversion. */
export function rawStorageLimitBytes(observation: AssistantConfig['Observation']): number {
  return observation.RawStorageLimitGb * BYTES_PER_GB;
}

export interface CaptureRetentionSummary {
  readonly expired: number;
  readonly evicted: number;
}

export interface CaptureRetentionOptions {
  readonly clock: Clock;
  readonly graph: AssistantGraph;
  readonly queue: CaptureQueueStore;
  readonly observation: AssistantConfig['Observation'];
}

/**
 * Enforces the earlier of `RawRetentionHours` and `RawStorageLimitGb` over stored captures
 * (spec §7). Deterministic, no model: blobs are deleted, evidence tombstoned, one audit event
 * written per removal, and every dependent assertion's confidence re-derived — pixels the user
 * can no longer inspect stop counting as support.
 */
export class CaptureRetentionService {
  private readonly clock: Clock;
  private readonly graph: AssistantGraph;
  private readonly queue: CaptureQueueStore;
  private observation: AssistantConfig['Observation'];

  constructor(options: CaptureRetentionOptions) {
    this.clock = options.clock;
    this.graph = options.graph;
    this.queue = options.queue;
    this.observation = options.observation;
  }

  refreshObservation(observation: AssistantConfig['Observation']): void {
    this.observation = observation;
  }

  /** `reason` is the pass's provenance (scheduled drain vs capacity pressure), audited per removal. */
  run(ownerId: string, reason: CaptureRetentionPayload['reason']): CaptureRetentionSummary {
    let expired = 0;
    const cutoffUtc = new Date(
      this.clock.nowEpochMs() - this.observation.RawRetentionHours * 3_600_000,
    ).toISOString();
    for (const row of this.queue.listLiveOldestFirst(ownerId)) {
      if (row.enqueued_at_utc < cutoffUtc) {
        this.retire(ownerId, row, 'expired', reason);
        expired += 1;
      }
    }

    let evicted = 0;
    const limitBytes = rawStorageLimitBytes(this.observation);
    let totalBytes = this.queue.totalLiveBytes(ownerId);
    if (totalBytes > limitBytes) {
      for (const row of this.queue.listLiveOldestFirst(ownerId)) {
        if (totalBytes <= limitBytes) break;
        this.retire(ownerId, row, 'evicted', reason);
        totalBytes -= row.byte_length;
        evicted += 1;
      }
    }
    return { expired, evicted };
  }

  private retire(
    ownerId: string,
    row: CaptureQueueRow,
    kind: 'expired' | 'evicted',
    reason: CaptureRetentionPayload['reason'],
  ): void {
    this.queue.setState(row.evidence_id, kind);
    this.graph.evidence.expireEvidence(row.evidence_id);
    this.graph.audit.recordAuditEvent({
      ownerId,
      eventType: kind === 'expired' ? 'capture_expired' : 'capture_evicted',
      targetType: 'desktop_capture',
      targetId: row.evidence_id,
      summary: kind === 'expired'
        ? 'Capture expired: raw pixels aged past the retention window.'
        : 'Capture evicted: raw storage exceeded its size cap.',
      details: {
        evidenceId: row.evidence_id,
        byteLength: row.byte_length,
        enqueuedAtUtc: row.enqueued_at_utc,
        reason,
      },
    });
    for (const assertionId of this.graph.assertions.listAssertionIdsForEvidence(row.evidence_id)) {
      this.graph.assertionService.recalculateConfidence({
        ownerId,
        assertionId,
        reason: kind === 'expired'
          ? 'supporting capture expired by retention'
          : 'supporting capture evicted by the storage cap',
      });
    }
  }
}
