import { ImageDataUrlSchema, removeCallouts, replaceSection, type VaultWriteMeta } from '@siftkit/contracts';

import type { Clock } from '../../assistant/clock.ts';
import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import { isUsableCapability, type AssistantImageCapabilityProvider } from '../../assistant/images/image-capability.ts';
import type { StructuredOutputRunner } from '../../assistant/inference/structured-runner.ts';
import { QueryIntentExtractor } from '../../assistant/retrieval/query-intent.ts';
import type { AuditStore } from '../../assistant/storage/audit-store.ts';
import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import type { VaultAttachments } from '../attachments.ts';
import { finishCapture, requireCapture, setCaptureState, type VaultCaptureRow } from '../captures.ts';
import { VaultNotFoundError } from '../errors.ts';
import { requireVaultNote } from '../note-rows.ts';
import type { VaultNoteStore } from '../note-store.ts';
import { LEARNED_HEADING, PENDING_CALLOUT_KIND } from '../vault-layout.ts';
import { knownNotesText } from './candidates.ts';
import type { VaultEditApplier } from './edit-applier.ts';
import { VAULT_EDIT_INSTRUCTIONS, VaultEditResponseSchema } from './edit-ops.ts';
import { outputRejectionDetails } from './rejections.ts';

const INSTRUCTIONS = [
  "The image is a screenshot of the user's screen. Record what it shows about the user:",
  'the tools, projects, people, places, plans and preferences visible in it.',
  VAULT_EDIT_INSTRUCTIONS,
].join('\n');

export type VaultCaptureWriteOutcome =
  | { readonly kind: 'processed'; readonly learned: readonly string[]; readonly touchedNoteIds: readonly string[] }
  | { readonly kind: 'awaiting_capability' }
  | { readonly kind: 'already_processed' }
  | { readonly kind: 'rejected'; readonly reason: 'image_missing' | 'invalid_output' };

export interface VaultCaptureWriterOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly attachments: VaultAttachments;
  readonly applier: VaultEditApplier;
  readonly audit: AuditStore;
  readonly scanner: SecretScanner;
  readonly clock: Clock;
  readonly runner: StructuredOutputRunner;
  readonly capability: AssistantImageCapabilityProvider;
}

/**
 * Turns one capture into vault edits (design §4.1). Capability is read at admission and again just
 * before dispatch, so a runtime that reloaded mid-job sends the capture back to wait.
 */
export class VaultCaptureWriter {
  private readonly database: RuntimeDatabase;
  private readonly store: VaultNoteStore;
  private readonly attachments: VaultAttachments;
  private readonly applier: VaultEditApplier;
  private readonly audit: AuditStore;
  private readonly scanner: SecretScanner;
  private readonly clock: Clock;
  private readonly runner: StructuredOutputRunner;
  private readonly capability: AssistantImageCapabilityProvider;

  constructor(options: VaultCaptureWriterOptions) {
    this.database = options.database;
    this.store = options.store;
    this.attachments = options.attachments;
    this.applier = options.applier;
    this.audit = options.audit;
    this.scanner = options.scanner;
    this.clock = options.clock;
    this.runner = options.runner;
    this.capability = options.capability;
  }

  async run(ownerId: string, attachmentId: string, abortSignal: AbortSignal | null): Promise<VaultCaptureWriteOutcome> {
    const capture = requireCapture(this.database, attachmentId);
    if (capture.processed_at_utc !== null) return { kind: 'already_processed' };
    const admission = this.capability.read();
    if (!isUsableCapability(admission)) return this.awaitCapability(attachmentId);
    setCaptureState(this.database, attachmentId, 'processing');

    const image = this.readImage(capture);
    // Retention may have deleted the file first; retrying cannot bring it back, so this is terminal.
    if (image === null) {
      this.finish(capture, [], 'image_removed');
      return { kind: 'rejected', reason: 'image_missing' };
    }
    if (this.capability.read().instanceId !== admission.instanceId) return this.awaitCapability(attachmentId);

    const outcome = await this.runner.runWithImages({
      role: 'vault_capture_writer', instructions: INSTRUCTIONS, userText: this.userText(capture), images: [image],
      schemaName: 'vault_capture_edits', schema: VaultEditResponseSchema, abortSignal,
    });
    if (!outcome.ok) {
      this.audit.recordAuditEvent({
        ownerId, eventType: 'vault_writer_rejected', targetType: 'vault_capture', targetId: attachmentId,
        summary: 'Screenshot note-writer produced no usable structured output.', details: outputRejectionDetails(this.scanner, outcome),
      });
      this.finish(capture, [], 'processed');
      return { kind: 'rejected', reason: 'invalid_output' };
    }
    return this.database.transaction((): VaultCaptureWriteOutcome => {
      const note = requireVaultNote(this.database, capture.note_id);
      const result = this.applier.apply({
        ownerId, operations: outcome.value.operations, actor: 'note-writer · screenshot', sourceRef: attachmentId, summary: `Screenshot ${note.title}`,
      });
      this.finish(capture, result.learned, 'processed');
      return { kind: 'processed', learned: result.learned, touchedNoteIds: result.touchedNoteIds };
    })();
  }

  private awaitCapability(attachmentId: string): VaultCaptureWriteOutcome {
    setCaptureState(this.database, attachmentId, 'awaiting_image_capability');
    return { kind: 'awaiting_capability' };
  }

  private readImage(capture: VaultCaptureRow): string | null {
    try {
      const { mimeType, bytes } = this.attachments.read(this.attachments.require(capture.attachment_id).relativePath);
      return ImageDataUrlSchema.parse(`data:${mimeType};base64,${bytes.toString('base64')}`);
    } catch (error) {
      if (error instanceof VaultNotFoundError) return null;
      throw error;
    }
  }

  private userText(capture: VaultCaptureRow): string {
    return [
      `App: ${capture.app}`,
      ...(capture.window_title === null ? [] : [`Window title: ${capture.window_title}`]),
      knownNotesText(this.database, new QueryIntentExtractor().extract(`${capture.app} ${capture.window_title ?? ''}`).terms),
    ].join('\n');
  }

  /** Swaps the pending callout for `## Learned` (empty on failure) and closes the capture. */
  private finish(capture: VaultCaptureRow, learned: readonly string[], state: 'processed' | 'image_removed'): void {
    this.database.transaction(() => {
      const note = requireVaultNote(this.database, capture.note_id);
      const meta: VaultWriteMeta = { actor: 'note-writer · screenshot', summary: 'Learned from screenshot', sourceRef: capture.attachment_id };
      this.store.update(note.id, { body: replaceSection(removeCallouts(note.body, PENDING_CALLOUT_KIND), LEARNED_HEADING, learned) }, note.revision, meta);
      finishCapture(this.database, capture.attachment_id, state, this.clock.nowUtc());
    })();
  }
}
