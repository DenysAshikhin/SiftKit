import type { ChatHistoryRevision, ChatJournalEvent } from '../../state/chat-journal-schema.js';
import type { ChatContextInit, ChatContextSplice } from '../planner-chat-message.js';

/** One journal event family without the discriminator, which the recorder stamps on itself. */
type EvidenceBody<Kind extends ChatJournalEvent['kind']> = Omit<Extract<ChatJournalEvent, { kind: Kind }>, 'kind'>;

export type ChatToolProposedEvidence = EvidenceBody<'tool_proposed'>;
export type ChatToolStartedEvidence = EvidenceBody<'tool_started'>;
export type ChatToolResultEvidence = EvidenceBody<'tool_result'>;
export type ChatToolResultFinalizedEvidence = EvidenceBody<'tool_result_finalized'>;
export type ChatApprovalReviewedEvidence = EvidenceBody<'approval_reviewed'>;
export type ChatApprovalRequestedEvidence = EvidenceBody<'approval_requested'>;
export type ChatApprovalResolvedEvidence = EvidenceBody<'approval_resolved'>;

/**
 * Where planner history is written down before it is applied. A run bound to a durable chat supplies
 * one; a terminal run does not, and then the transcript is the only record there is.
 */
export interface ChatContextRecorder {
  readonly userMessageId: string;
  readonly messageIdPrefix: string;
  resolveAssistantMessageId(turn: number): string;
  resolveToolMessageId(toolCallId: string): string | null;
  readonly historyRevision: number;
  readHistoryRevisions(): ChatHistoryRevision[];
  /** Both return exactly the value committed, which may differ from the proposal by deleted images. */
  recordContextInitialized(init: ChatContextInit): ChatContextInit;
  recordContextSpliced(splice: ChatContextSplice): ChatContextSplice;
}

/**
 * Everything one Web run commits before acting on it. Every method is synchronous and throws on a
 * failed write: unrecorded evidence must stop the run rather than let it act unrecorded.
 */
export interface ChatRunEvidenceRecorder extends ChatContextRecorder {
  readonly abortSignal: AbortSignal;
  recordApprovalReviewed(evidence: ChatApprovalReviewedEvidence): void;
  recordApprovalRequested(evidence: ChatApprovalRequestedEvidence): void;
  recordApprovalResolved(evidence: ChatApprovalResolvedEvidence): void;
  recordToolProposed(evidence: ChatToolProposedEvidence): void;
  recordToolStarted(evidence: ChatToolStartedEvidence): void;
  recordToolResult(evidence: ChatToolResultEvidence): void;
  recordToolResultFinalized(evidence: ChatToolResultFinalizedEvidence): void;
}
