import type { RepoAgentDecision } from '@siftkit/contracts';

import type { RepoAgentApproval } from '../repo-agent/run-schemas.js';

export type ChatRepoAgentDecisionRecord = {
  decision: RepoAgentDecision;
  approval: RepoAgentApproval;
  decidedAtUtc: string;
};

export type ChatRepoAgentRunBinding = {
  runId: string;
  decisions: ChatRepoAgentDecisionRecord[];
};
