import {
  resolveRepoSearchPlannerToolDefinitions,
  type PlannerThinkingFlags,
} from '../../src/repo-search/planner-protocol.ts';
import { buildApprovalReviewRequest } from '../../src/repo-search/approval-review-policy.ts';
import { toProtocolTools } from '../../src/providers/inference.ts';

export const THINKING_ON_FLAGS = {
  thinkingEnabled: true,
  reasoningContentEnabled: true,
  preserveThinking: true,
} satisfies PlannerThinkingFlags;

/** A proposed edit with its payload inline, as the gate renders it for the approver. */
export const VERDICT_FIXTURE_REQUEST = buildApprovalReviewRequest({
  toolName: 'edit',
  command: 'edit path="src/a.ts" edits=1 sha="0123456789"',
  reviewPayload: JSON.stringify({ toolName: 'edit', args: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] } }, null, 2),
});

/** The request-bound half of a verdict call; callers add config, endpoint, and timing. */
export function baseVerdictOptions(flags: PlannerThinkingFlags = THINKING_ON_FLAGS) {
  return {
    reviewRequest: VERDICT_FIXTURE_REQUEST,
    tools: toProtocolTools(resolveRepoSearchPlannerToolDefinitions()),
    flags,
  };
}
