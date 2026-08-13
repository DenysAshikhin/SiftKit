import type { IngestionPipeline } from './pipeline.js';

export interface ChatTurnInput {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly capturedAtUtc: string;
  readonly userMessageId: string;
  readonly userText: string;
  readonly assistantMessageId: string;
  /** The final answer only. Hidden reasoning is never passed in and never ingested (§7.2). */
  readonly assistantText: string;
}

export interface ChatTurnIngestResult {
  readonly acceptedEvidenceIds: readonly string[];
  readonly suppressed: boolean;
}

/** "Do not remember this", in the phrasings a user actually types. */
const SUPPRESSION_PATTERN =
  /\b(?:do\s*n(?:o|')t\s+remember\s+(?:this|that)|forget\s+(?:this|that)|don't\s+save\s+this)\b/i;

/**
 * Turns one completed chat turn into ingestion envelopes (§7.2). It reads no session state and
 * writes no graph rows — every persistence decision belongs to the pipeline.
 */
export class ConversationIngestor {
  constructor(private readonly pipeline: IngestionPipeline) {}

  ingestTurn(input: ChatTurnInput): ChatTurnIngestResult {
    if (SUPPRESSION_PATTERN.test(input.userText)) {
      this.pipeline.suppressTurn({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        sourceEventIds: [
          `${input.sessionId}:${input.userMessageId}`,
          `${input.sessionId}:${input.assistantMessageId}`,
        ],
      });
      return { acceptedEvidenceIds: [], suppressed: true };
    }

    const acceptedEvidenceIds: string[] = [];
    for (const message of this.messages(input)) {
      if (message.text.trim().length === 0) continue;
      const outcome = this.pipeline.accept({
        ownerId: input.ownerId,
        deviceId: null,
        sourceType: 'conversation_message',
        sourceEventId: `${input.sessionId}:${message.messageId}`,
        sourceRef: input.sessionId,
        capturedAtUtc: input.capturedAtUtc,
        sourceTimezone: null,
        declaredSensitivity: null,
        payload: { kind: 'text', text: message.text },
        metadata: { sessionId: input.sessionId, messageId: message.messageId, role: message.role },
      });
      if (outcome.kind === 'accepted') {
        acceptedEvidenceIds.push(outcome.evidenceId);
      }
    }
    return { acceptedEvidenceIds, suppressed: false };
  }

  private messages(input: ChatTurnInput): readonly {
    readonly messageId: string;
    readonly role: 'user' | 'assistant';
    readonly text: string;
  }[] {
    return [
      { messageId: input.userMessageId, role: 'user', text: input.userText },
      { messageId: input.assistantMessageId, role: 'assistant', text: input.assistantText },
    ];
  }
}