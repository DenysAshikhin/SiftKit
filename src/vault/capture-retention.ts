import type { Clock } from '../assistant/clock.ts';
import type { AuditStore } from '../assistant/storage/audit-store.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import type { VaultAttachments } from './attachments.ts';
import { listLiveCapturesOldestFirst, setCaptureState, type LiveCapture } from './captures.ts';

const MS_PER_DAY = 86_400_000;

export interface VaultCaptureRetentionLimits {
  readonly limitBytes: number;
  /** `null` turns the age limit off. */
  readonly maxAgeDays: number | null;
}

export interface VaultCaptureRetentionSummary {
  readonly expired: number;
  readonly evicted: number;
}

export interface VaultCaptureRetentionOptions {
  readonly database: RuntimeDatabase;
  readonly attachments: VaultAttachments;
  readonly audit: AuditStore;
  readonly clock: Clock;
}

/**
 * Enforces the optional age limit, then the size cap, over capture PNGs (design §4.2). Only files
 * go: the row becomes `image_removed` and the note keeps its embed. One audit event per removal.
 */
export class VaultCaptureRetention {
  private readonly database: RuntimeDatabase;
  private readonly attachments: VaultAttachments;
  private readonly audit: AuditStore;
  private readonly clock: Clock;

  constructor(options: VaultCaptureRetentionOptions) {
    this.database = options.database;
    this.attachments = options.attachments;
    this.audit = options.audit;
    this.clock = options.clock;
  }

  run(ownerId: string, limits: VaultCaptureRetentionLimits): VaultCaptureRetentionSummary {
    let expired = 0;
    if (limits.maxAgeDays !== null) {
      const cutoffUtc = new Date(this.clock.nowEpochMs() - limits.maxAgeDays * MS_PER_DAY).toISOString();
      for (const capture of listLiveCapturesOldestFirst(this.database).filter((row) => row.captured_at_utc < cutoffUtc)) {
        this.remove(ownerId, capture, 'capture_expired');
        expired += 1;
      }
    }
    let evicted = 0;
    const live = listLiveCapturesOldestFirst(this.database);
    let totalBytes = live.reduce((sum, row) => sum + row.byte_length, 0);
    for (const capture of live) {
      if (totalBytes <= limits.limitBytes) break;
      this.remove(ownerId, capture, 'capture_evicted');
      totalBytes -= capture.byte_length;
      evicted += 1;
    }
    return { expired, evicted };
  }

  private remove(ownerId: string, capture: LiveCapture, eventType: 'capture_expired' | 'capture_evicted'): void {
    this.attachments.removeFile(capture.attachment_id);
    setCaptureState(this.database, capture.attachment_id, 'image_removed');
    this.audit.recordAuditEvent({
      ownerId, eventType, targetType: 'vault_capture', targetId: capture.attachment_id,
      summary: eventType === 'capture_expired' ? 'Capture image expired: older than the age limit.' : 'Capture image evicted: storage exceeded its size cap.',
      details: { byteLength: capture.byte_length, capturedAtUtc: capture.captured_at_utc },
    });
  }
}
