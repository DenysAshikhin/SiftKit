import { ImageDataUrlSchema } from '@siftkit/contracts';

import { z } from '../../lib/zod.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { buildProposedStatementSchema } from '../domain/proposal-schema.js';
import type { StructuredOutputRunner } from '../inference/structured-runner.js';
import type { EvidenceRow } from '../storage/rows.js';
import type { CaptureQueueStore } from './capture-queue-store.js';
import { isUsableCapability, type AssistantImageCapabilityProvider } from './image-capability.js';

const ScreenshotStatementSchema = buildProposedStatementSchema({});

export const ImageExtractionSchema = z.object({
  statements: z.array(ScreenshotStatementSchema).max(10),
}).strict();

const EXTRACTOR_INSTRUCTIONS = [
  'Describe the durable facts about the user that the supplied screenshot shows — the tools,',
  'projects, and preferences visible in it. Report only what is observable.',
  'Each predicate accepts only the subject and object types shown in its schema variant.',
  'Omit anything ambiguous or transient. Leave scope null unless the fact holds only in a',
  'named context.',
  'Never propose credentials, protected traits, or a medical diagnosis.',
  'Output JSON only.',
].join('\n');

const EXTRACTOR_USER_TEXT = 'Describe the durable facts this screenshot shows about the user.';

export type ImageExtractionOutcome =
  | {
      readonly kind: 'processed';
      readonly observationIds: readonly string[];
      readonly candidateIds: readonly string[];
    }
  | { readonly kind: 'awaiting_capability' }
  | { readonly kind: 'already_processed' }
  | { readonly kind: 'rejected' };

export interface ImageExtractorOptions {
  readonly graph: AssistantGraph;
  readonly queue: CaptureQueueStore;
  readonly runner: StructuredOutputRunner;
  readonly capability: AssistantImageCapabilityProvider;
}

/**
 * Turns one queued screenshot into passive observations. Capability is read twice — once to admit
 * the item and once immediately before dispatch — so a runtime that unloaded mid-job sends the
 * item back to the queue instead of failing it (spec §5). Decrypted pixels live only inside `run`.
 */
export class ImageExtractor {
  private readonly graph: AssistantGraph;
  private readonly queue: CaptureQueueStore;
  private readonly runner: StructuredOutputRunner;
  private readonly capability: AssistantImageCapabilityProvider;

  constructor(options: ImageExtractorOptions) {
    this.graph = options.graph;
    this.queue = options.queue;
    this.runner = options.runner;
    this.capability = options.capability;
  }

  async run(
    ownerId: string, evidenceId: string, abortSignal: AbortSignal | null,
  ): Promise<ImageExtractionOutcome> {
    const queued = this.queue.require(evidenceId);
    if (queued.state === 'processed') return { kind: 'already_processed' };

    const admission = this.capability.read();
    if (!isUsableCapability(admission)) {
      this.queue.setState(evidenceId, 'awaiting_image_capability');
      return { kind: 'awaiting_capability' };
    }
    this.queue.setState(evidenceId, 'processing');

    const evidence = this.graph.evidence.requireEvidence(evidenceId);
    // Retention deletes blobs by age without consulting queued work, so the pixels may already be
    // gone. That is terminal, not a failure: retrying cannot bring a deleted blob back, and
    // letting the read throw burned the job's whole retry budget before dead-lettering it.
    if (!this.graph.evidence.hasReadableBlob(evidence)) {
      this.discardDeletedBlob(ownerId, evidenceId);
      return { kind: 'rejected' };
    }
    const imageDataUrl = this.readImageDataUrl(evidence);
    if (this.capability.read().instanceId !== admission.instanceId) {
      this.queue.setState(evidenceId, 'awaiting_image_capability');
      return { kind: 'awaiting_capability' };
    }

    const outcome = await this.runner.runWithImages({
      role: 'image_extraction',
      instructions: EXTRACTOR_INSTRUCTIONS,
      userText: EXTRACTOR_USER_TEXT,
      images: [imageDataUrl],
      schemaName: 'assistant_screenshot_statements',
      schema: ImageExtractionSchema,
      abortSignal,
    });
    if (!outcome.ok) {
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'extraction_rejected',
        targetType: 'evidence',
        targetId: evidenceId,
        summary: 'Screenshot extraction produced no usable structured output.',
        details: { code: outcome.code, attempts: outcome.attempts, rawSample: outcome.rawSample },
      });
      this.queue.markProcessed(evidenceId);
      return { kind: 'rejected' };
    }

    const observationIds: string[] = [];
    const candidateIds: string[] = [];
    const transaction = this.graph.transactions.begin();
    try {
      for (const statement of outcome.value.statements) {
        const observation = this.graph.observations.record({
          ownerId,
          evidenceId,
          observationType: 'screenshot_extraction',
          payload: { rationale: statement.rationale, predicate: statement.predicate },
          confidence: statement.suggestedConfidence,
          sensitivity: evidence.sensitivity,
          extractorName: 'image_extraction',
          extractorVersion: outcome.promptVersion,
        });
        observationIds.push(observation.id);

        const candidate = this.graph.candidates.propose({
          ownerId,
          observationId: observation.id,
          subject: statement.subject,
          predicate: statement.predicate,
          object: statement.object,
          scope: statement.scope,
          basis: 'passive_observation',
          confidence: statement.suggestedConfidence,
          sensitivity: evidence.sensitivity,
          validFromUtc: null,
          validToUtc: null,
          rationale: statement.rationale,
        });
        if (candidate !== null) {
          candidateIds.push(candidate.id);
        }
      }
      transaction.commit();
    } catch (error) {
      return transaction.rollbackAfter(error);
    }

    this.queue.markProcessed(evidenceId);
    return { kind: 'processed', observationIds, candidateIds };
  }

  /**
   * Retires a capture whose pixels retention already removed. Terminal, not a failure: the blob
   * cannot come back, so the capture is marked processed and the cause is audited.
   */
  discardDeletedBlob(ownerId: string, evidenceId: string): void {
    this.graph.audit.recordAuditEvent({
      ownerId,
      eventType: 'extraction_rejected',
      targetType: 'evidence',
      targetId: evidenceId,
      summary: 'Screenshot pixels were deleted before extraction ran.',
      details: { code: 'blob_deleted' },
    });
    this.queue.markProcessed(evidenceId);
  }

  private readImageDataUrl(evidence: EvidenceRow): string {
    if (evidence.blob_id === null) {
      throw new Error(`Screenshot evidence ${evidence.id} has no stored image.`);
    }
    const bytes = this.graph.evidence.readBlobBytes(evidence.blob_id);
    return ImageDataUrlSchema.parse(
      `data:${evidence.mime_type};base64,${bytes.toString('base64')}`,
    );
  }
}
