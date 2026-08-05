import { stableStringify } from '../../lib/json.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { isSensitivityAtLeast, type Sensitivity } from '../domain/enums.js';
import type { SecretScanner } from '../domain/secrets.js';
import { IngestionEnvelopeSchema, type IngestionEnvelope } from './envelope.js';

export interface SuppressTurnInput {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly sourceEventIds: readonly string[];
}

export type IngestionOutcome =
  | { readonly kind: 'accepted'; readonly evidenceId: string; readonly jobId: string }
  | { readonly kind: 'duplicate'; readonly evidenceId: string }
  | {
      readonly kind: 'discarded';
      readonly reason: 'secret_prohibited' | 'blocked_topic';
    };

/**
 * The request-path half of §7.1. Constant work: scan, dedupe, one insert, one enqueue. The model
 * never runs here, so a chat turn never waits on the assistant.
 */
export class IngestionPipeline {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly secrets: SecretScanner,
  ) {}

  accept(input: IngestionEnvelope): IngestionOutcome {
    const envelope = IngestionEnvelopeSchema.parse(input);
    const text = this.renderText(envelope);
    const scan = this.secrets.scan(text);

    if (scan.containsSecret) {
      this.graph.audit.recordAuditEvent({
        ownerId: envelope.ownerId,
        eventType: 'evidence_discarded_secret',
        targetType: 'evidence',
        targetId: null,
        summary: 'Discarded ingestion payload containing credential material.',
        details: { sourceEventId: envelope.sourceEventId, rules: [...scan.matchedRuleIds] },
      });
      return { kind: 'discarded', reason: 'secret_prohibited' };
    }

    for (const topic of scan.topics) {
      if (this.graph.policies.isTopicBlockedFromInference(envelope.ownerId, topic)) {
        this.graph.audit.recordAuditEvent({
          ownerId: envelope.ownerId,
          eventType: 'evidence_discarded_blocked_topic',
          targetType: 'evidence',
          targetId: null,
          summary: `Discarded ingestion payload for blocked topic ${topic}.`,
          details: { sourceEventId: envelope.sourceEventId, topic },
        });
        return { kind: 'discarded', reason: 'blocked_topic' };
      }
    }

    const existing = this.graph.evidence.findBySourceEventId(
      envelope.ownerId, envelope.sourceEventId,
    );
    if (existing !== null) {
      return { kind: 'duplicate', evidenceId: existing.id };
    }

    return this.graph.transaction(() => {
      const evidence = this.graph.evidence.recordTextEvidence({
        ownerId: envelope.ownerId,
        deviceId: envelope.deviceId,
        sourceEventId: envelope.sourceEventId,
        parentEvidenceId: null,
        sourceType: envelope.sourceType,
        sourceRef: envelope.sourceRef,
        capturedAtUtc: envelope.capturedAtUtc,
        sourceTimezone: envelope.sourceTimezone,
        sensitivity: this.resolveSensitivity(scan.sensitivityFloor),
        retentionUntilUtc: null,
        metadata: envelope.metadata,
        text,
      });
      const job = this.graph.jobs.enqueue({
        ownerId: envelope.ownerId,
        jobType: 'conversation_ingestion',
        payload: {
          evidenceId: evidence.id,
          sessionId: envelope.sourceRef ?? evidence.id,
        },
        idempotencyKey: `conversation_ingestion:${evidence.id}`,
      });
      if (job === null) {
        // The key is derived from an evidence id minted moments ago, so no live job can hold
        // it. Reaching here means id generation is not unique — never silently continue.
        throw new Error(`Ingestion job key collided for fresh evidence ${evidence.id}.`);
      }
      return { kind: 'accepted', evidenceId: evidence.id, jobId: job.id };
    });
  }

  private renderText(envelope: IngestionEnvelope): string {
    return envelope.payload.kind === 'text'
      ? envelope.payload.text
      : stableStringify(envelope.payload.value);
  }

  private resolveSensitivity(floor: Sensitivity): Sensitivity {
    return isSensitivityAtLeast(floor, 'personal') ? floor : 'personal';
  }

  /**
   * "Do not remember this" (§7.2): no candidate is created and any evidence already written for
   * those events is deleted. Only a non-content audit event survives.
   */
  suppressTurn(input: SuppressTurnInput): void {
    this.graph.transaction(() => {
      for (const sourceEventId of input.sourceEventIds) {
        const evidence = this.graph.evidence.findBySourceEventId(input.ownerId, sourceEventId);
        if (evidence !== null) {
          this.graph.evidence.deleteEvidence(evidence.id);
        }
      }
      this.graph.audit.recordAuditEvent({
        ownerId: input.ownerId,
        eventType: 'turn_suppressed_by_user',
        targetType: 'chat_session',
        targetId: input.sessionId,
        summary: 'User asked not to remember this turn; evidence removed.',
        details: { sourceEventIds: [...input.sourceEventIds] },
      });
    });
  }
}