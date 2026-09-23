import type { RepoAgentApproval, RepoAgentDecision } from '@siftkit/contracts';

export type ChatRepoAgentDecisionRecord = {
  decision: RepoAgentDecision;
  approval: RepoAgentApproval;
  decidedAtUtc: string;
};

export type ChatRepoAgentRunBinding = {
  runId: string;
  decisions: ChatRepoAgentDecisionRecord[];
};
