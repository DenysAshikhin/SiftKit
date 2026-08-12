import {
  splitImageDataUrl,
  type CaptureSubmissionDto, type ImageMime, type SuppressionAuditDto,
} from '@siftkit/contracts';

import type { AssistantConfig } from '../../config/types.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { Clock } from '../clock.js';
import type { CaptureQueueState } from '../domain/enums.js';
import {
  isUsableCapability, type AssistantImageCapabilityProvider,
} from '../images/image-capability.js';
import type { CaptureQueueStore } from '../images/capture-queue-store.js';
import { rawStorageLimitBytes } from '../images/capture-retention.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { EvidenceStore } from '../storage/evidence-store.js';
import type { JobStore } from '../storage/job-store.js';
import { requireObservationAllowed } from './observation-gate.js';

/** The shell ships a 64-bit dHash; `PerceptualHashSchema` guarantees the 16 hex characters. */
const PERCEPTUAL_HASH_BITS = 64;

export type CaptureOutcome =
  | { readonly kind: 'accepted'; readonly evidenceId: string; readonly state: CaptureQueueState }
  | { readonly kind: 'duplicate_discarded' }
  | { readonly kind: 'skipped_duplicate' };

export interface CaptureIntakeOptions {
  readonly clock: Clock;
  readonly evidence: EvidenceStore;
  readonly queue: CaptureQueueStore;
  readonly audit: AuditStore;
  readonly capability: AssistantImageCapabilityProvider;
  readonly jobs: JobStore;
}

function hammingDistance(left: string, right: string): number {
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let bits = 0;
  while (difference > 0n) {
    bits += Number(difference & 1n);
    difference >>= 1n;
  }
  return bits;
}

function decodeCaptureImage(dataUrl: string): { mimeType: ImageMime; bytes: Buffer } {
  const split = splitImageDataUrl(dataUrl);
  if (split === null) {
    throw new Error('Capture image must be a base64 image data URL.');
  }
  const bytes = Buffer.from(split.base64, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('Capture image decoded to zero bytes.');
  }
  return { mimeType: split.mime, bytes };
}

/**
 * The daemon half of screenshot capture: it owns the dedupe thresholds, encryption at rest, and
 * queue admission. Rust computes the hashes and the privacy preflight; every decision that turns
 * pixels into stored evidence is made here (spec §4).
 */
export class CaptureIntake {
  private readonly clock: Clock;
  private readonly evidence: EvidenceStore;
  private readonly queue: CaptureQueueStore;
  private readonly audit: AuditStore;
  private readonly capability: AssistantImageCapabilityProvider;
  private readonly jobs: JobStore;

  constructor(options: CaptureIntakeOptions) {
    this.clock = options.clock;
    this.evidence = options.evidence;
    this.queue = options.queue;
    this.audit = options.audit;
    this.capability = options.capability;
    this.jobs = options.jobs;
  }

  submit(ownerId: string, capture: CaptureSubmissionDto, config: AssistantConfig): CaptureOutcome {
    requireObservationAllowed(config);
    if (!config.Observation.ScreenshotsEnabled) {
      throw new Error('Screenshot capture is disabled.');
    }

    const perceptualHash = capture.perceptualHash;
    const windowStartUtc = this.retentionWindowStart(config.Observation.RawRetentionHours);
    if (this.queue.findByPixelSha(ownerId, capture.pixelSha256, windowStartUtc) !== null) {
      this.audit.recordAuditEvent({
        ownerId,
        eventType: 'duplicate_discarded',
        targetType: 'desktop_capture',
        targetId: null,
        summary: 'Capture discarded: identical pixels are already stored.',
        details: { reason: 'exact_pixel_match' },
      });
      return { kind: 'duplicate_discarded' };
    }

    const similarityPercent = this.closestSimilarityPercent(
      ownerId, capture.foregroundContextKey, perceptualHash, windowStartUtc,
    );
    if (similarityPercent !== null
      && similarityPercent >= config.Observation.DuplicateSimilarityPercent) {
      this.audit.recordAuditEvent({
        ownerId,
        eventType: 'skipped_duplicate',
        targetType: 'desktop_capture',
        targetId: null,
        summary: 'Capture skipped: perceptually identical to a recent capture.',
        details: { reason: 'perceptual_match', similarityPercent },
      });
      return { kind: 'skipped_duplicate' };
    }

    const image = decodeCaptureImage(capture.imageDataUrl);
    const evidence = this.evidence.recordBlobEvidence({
      ownerId,
      deviceId: null,
      // The source event is this capture attempt, not these pixels: identical pixels captured
      // again once the dedupe window has passed are a new event with their own evidence row.
      sourceEventId: `capture:${capture.capturedAtUtc}:${capture.pixelSha256}`,
      parentEvidenceId: null,
      sourceType: 'screenshot',
      sourceRef: capture.foreground.applicationId,
      capturedAtUtc: capture.capturedAtUtc,
      sourceTimezone: null,
      sensitivity: 'sensitive',
      retentionUntilUtc: null,
      metadata: this.captureMetadata(capture),
      mimeType: image.mimeType,
      bytes: image.bytes,
    });
    const state = this.admissionState();
    this.queue.enqueue({
      ownerId,
      evidenceId: evidence.id,
      state,
      foregroundContextKey: capture.foregroundContextKey,
      pixelSha256: capture.pixelSha256,
      perceptualHash,
      byteLength: image.bytes.byteLength,
    });
    // Capacity pressure cannot wait for the next scheduled run: the capture that crossed the
    // cap enqueues the eviction pass itself (spec §7). Idempotent while one is already live.
    if (this.queue.totalLiveBytes(ownerId) > rawStorageLimitBytes(config.Observation)) {
      this.jobs.enqueue({
        ownerId,
        jobType: 'capture_retention',
        payload: { reason: 'capacity' },
        idempotencyKey: 'capture_retention:capacity',
      }, config.Background.JobPriorities.CaptureRetention);
    }
    return { kind: 'accepted', evidenceId: evidence.id, state };
  }

  /**
   * The shell's report that a capture never happened. Rule id only: the suppressed window's
   * title and pixels are exactly what the rule was protecting (spec §4).
   */
  recordSuppression(ownerId: string, suppression: SuppressionAuditDto): void {
    this.audit.recordAuditEvent({
      ownerId,
      eventType: 'capture_suppressed',
      targetType: 'desktop_capture',
      targetId: suppression.ruleId,
      summary: 'Capture suppressed by the desktop privacy preflight.',
      details: { ruleId: suppression.ruleId, occurredAtUtc: suppression.occurredAtUtc },
    });
  }

  /** Queue admission is a live read: without a vision-capable runtime the item simply waits. */
  private admissionState(): CaptureQueueState {
    return isUsableCapability(this.capability.read()) ? 'queued' : 'awaiting_image_capability';
  }

  private retentionWindowStart(retentionHours: number): string {
    return new Date(this.clock.nowEpochMs() - retentionHours * 3_600_000).toISOString();
  }

  /** Highest similarity against live captures of the same foreground context, or `null`. */
  private closestSimilarityPercent(
    ownerId: string, foregroundContextKey: string, perceptualHash: string, windowStartUtc: string,
  ): number | null {
    let closest: number | null = null;
    for (const row of this.queue.listContextSince(ownerId, foregroundContextKey, windowStartUtc)) {
      const distance = hammingDistance(perceptualHash, row.perceptual_hash);
      const percent = (100 * (PERCEPTUAL_HASH_BITS - distance)) / PERCEPTUAL_HASH_BITS;
      if (closest === null || percent > closest) closest = percent;
    }
    return closest;
  }

  private captureMetadata(capture: CaptureSubmissionDto): JsonObject {
    return {
      reason: capture.reason,
      capturedAtUtc: capture.capturedAtUtc,
      foregroundContextKey: capture.foregroundContextKey,
      pixelSha256: capture.pixelSha256,
      perceptualHash: capture.perceptualHash,
      display: { ...capture.display },
      foreground: { ...capture.foreground },
    };
  }
}
