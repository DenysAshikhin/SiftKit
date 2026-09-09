import { ChatStreamApprovalSchema, type ChatStreamApproval, type RepoAgentDecision } from '@siftkit/contracts';

import type { RepoAgentApproval } from '../repo-agent/run-schemas.js';

/**
 * The one projection from a repo-agent approval onto the frame shape every chat surface renders,
 * so the approval card is built from the contract instead of being spelled out per call site.
 */
export function toChatStreamApproval(
  runId: string,
  approval: { approvalId: string; toolName: string; command: string; reviewPayload?: string | null },
): ChatStreamApproval {
  return ChatStreamApprovalSchema.parse({
    runId,
    approvalId: approval.approvalId,
    toolName: approval.toolName,
    command: approval.command,
    reviewPayload: approval.reviewPayload ?? null,
  });
}

export type ChatRepoAgentDecisionRecord = {
  decision: RepoAgentDecision;
  approval: RepoAgentApproval;
  decidedAtUtc: string;
};

export type ChatRepoAgentRunBinding = {
  runId: string;
  decisions: ChatRepoAgentDecisionRecord[];
};
