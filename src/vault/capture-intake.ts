import type { CaptureSubmissionDto, ForegroundContextDto, VaultWriteMeta } from '@siftkit/contracts';

import type { Clock } from '../assistant/clock.ts';
import { isUsableCapability, type AssistantImageCapabilityProvider } from '../assistant/images/image-capability.ts';
import { closestSimilarityPercent, decodeCaptureImage, retentionWindowStartUtc } from '../assistant/observation/capture-image.ts';
import { requireObservationAllowed } from '../assistant/observation/observation-gate.ts';
import type { AuditStore } from '../assistant/storage/audit-store.ts';
import type { AssistantConfig } from '../config/types.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { attachmentEmbed, type VaultAttachments } from './attachments.ts';
import { hasPixelCaptureSince, insertCapture, listContextHashesSince, type VaultCaptureState } from './captures.ts';
import { sanitizeVaultTitle, type VaultNoteStore } from './note-store.ts';
import { PENDING_CALLOUT, captureFolder } from './vault-layout.ts';
import { localDay, localTime } from './vault-time.ts';

export type VaultCaptureOutcome =
  | { readonly kind: 'accepted'; readonly attachmentId: string; readonly noteId: string; readonly state: VaultCaptureState }
  | { readonly kind: 'duplicate_discarded' }
  | { readonly kind: 'skipped_duplicate' };

export interface VaultCaptureIntakeOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly attachments: VaultAttachments;
  readonly audit: AuditStore;
  readonly clock: Clock;
  readonly capability: AssistantImageCapabilityProvider;
}

const FALLBACK_APP = 'Desktop';
const APP_MAX_LENGTH = 60;
/** Windows titles end with the app after a dash: "Inbox - Gmail - Google Chrome". */
const TITLE_APP_SEPARATOR = /\s[-–—]\s/;

/** The app a capture belongs to: the window title's last dash segment, else the process name, else Desktop. */
export function captureAppName(foreground: ForegroundContextDto): string {
  const segments = (foreground.normalizedTitle ?? '').split(TITLE_APP_SEPARATOR);
  const fromTitle = segments.length > 1 ? sanitizeVaultTitle(segments.at(-1) ?? '') : '';
  const fromProcess = sanitizeVaultTitle((foreground.processName ?? '').replace(/\.exe$/i, ''));
  return (fromTitle || fromProcess || FALLBACK_APP).slice(0, APP_MAX_LENGTH).trim();
}

/**
 * The vault half of screenshot capture: the legacy dedupe and admission rules, then the PNG
 * attachment, a pending capture note and its `vault_captures` row in one transaction.
 */
export class VaultCaptureIntake {
  private readonly database: RuntimeDatabase;
  private readonly store: VaultNoteStore;
  private readonly attachments: VaultAttachments;
  private readonly audit: AuditStore;
  private readonly clock: Clock;
  private readonly capability: AssistantImageCapabilityProvider;

  constructor(options: VaultCaptureIntakeOptions) {
    this.database = options.database;
    this.store = options.store;
    this.attachments = options.attachments;
    this.audit = options.audit;
    this.clock = options.clock;
    this.capability = options.capability;
  }

  submit(ownerId: string, capture: CaptureSubmissionDto, config: AssistantConfig): VaultCaptureOutcome {
    requireObservationAllowed(config);
    if (!config.Observation.ScreenshotsEnabled) throw new Error('Screenshot capture is disabled.');

    const windowStartUtc = retentionWindowStartUtc(this.clock, config.Observation.RawRetentionHours);
    if (hasPixelCaptureSince(this.database, capture.pixelSha256, windowStartUtc)) {
      this.recordDuplicate(ownerId, 'duplicate_discarded', 'Capture discarded: identical pixels are already stored.', { reason: 'exact_pixel_match' });
      return { kind: 'duplicate_discarded' };
    }
    const similarityPercent = closestSimilarityPercent(capture.perceptualHash, listContextHashesSince(this.database, capture.foregroundContextKey, windowStartUtc));
    if (similarityPercent !== null && similarityPercent >= config.Observation.DuplicateSimilarityPercent) {
      this.recordDuplicate(ownerId, 'skipped_duplicate', 'Capture skipped: perceptually identical to a recent capture.', { reason: 'perceptual_match', similarityPercent });
      return { kind: 'skipped_duplicate' };
    }

    const image = decodeCaptureImage(capture.imageDataUrl);
    const state: VaultCaptureState = isUsableCapability(this.capability.read()) ? 'queued' : 'awaiting_image_capability';
    const attachment = this.attachments.write({ directory: 'captures', mimeType: image.mimeType, bytes: image.bytes });
    try {
      return this.database.transaction((): VaultCaptureOutcome => {
        const app = captureAppName(capture.foreground);
        const day = localDay(capture.capturedAtUtc);
        const meta: VaultWriteMeta = { actor: 'capture-intake', summary: 'Screenshot captured', sourceRef: attachment.id };
        const note = this.store.create({
          title: this.store.availableTitle(`${day} ${localTime(capture.capturedAtUtc)} · ${app}`),
          folder: captureFolder(day), kind: 'capture', types: [], aliases: [], tags: [],
          body: [attachmentEmbed(attachment.relativePath), '', contextLine(app, capture), '', PENDING_CALLOUT].join('\n'),
        }, meta);
        this.attachments.assign(attachment.id, note.id);
        insertCapture(this.database, {
          attachment_id: attachment.id, note_id: note.id, state, foreground_context_key: capture.foregroundContextKey,
          pixel_sha256: capture.pixelSha256, perceptual_hash: capture.perceptualHash, app,
          window_title: capture.foreground.normalizedTitle?.trim() || null, captured_at_utc: capture.capturedAtUtc,
        });
        return { kind: 'accepted', attachmentId: attachment.id, noteId: note.id, state };
      })();
    } catch (error) {
      // The file and its row sit outside the transaction; without a note they must not outlive it.
      this.attachments.delete(attachment.id);
      throw error;
    }
  }

  private recordDuplicate(ownerId: string, eventType: 'duplicate_discarded' | 'skipped_duplicate', summary: string, details: { reason: string; similarityPercent?: number }): void {
    this.audit.recordAuditEvent({ ownerId, eventType, targetType: 'desktop_capture', targetId: null, summary, details });
  }
}

function contextLine(app: string, capture: CaptureSubmissionDto): string {
  const windowTitle = capture.foreground.normalizedTitle?.trim();
  const parts = [`[[${app}]]`, ...(windowTitle ? [`\`${windowTitle.replace(/`/g, "'")}\``] : []), capture.reason.replace(/_/g, ' ')];
  return parts.join(' · ');
}
