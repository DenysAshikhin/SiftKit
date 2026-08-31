import {
  ImageDataUrlSchema,
  RepoAgentAbortDecisionSchema,
  RepoAgentApproveDecisionSchema,
  RepoAgentDecisionSchema,
  RepoAgentDenyDecisionSchema,
} from '@siftkit/contracts';

import { z } from '../lib/zod.js';
import { ApprovalModeSchema } from '../repo-search/engine/approval-gate.js';
import { RepoSearchMockCommandResultSchema } from '../repo-search/types.js';
import { RepoAgentRunIdSchema } from './run-schemas.js';
import { MockPlannerResponsesSchema } from '../planner-protocol/mock-response.js';

export const RepoAgentStartRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1),
  repoRoot: z.string().min(1).optional(),
  approval: ApprovalModeSchema.optional(),
  model: z.string().min(1).nullable().optional(),
  logFile: z.string().min(1).optional(),
  images: z.array(ImageDataUrlSchema).optional(),
  promptPrefix: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  availableModels: z.array(z.string().min(1)).optional(),
  mockResponses: MockPlannerResponsesSchema.optional(),
  mockCommandResults: z.record(z.string(), RepoSearchMockCommandResultSchema).optional(),
});
export type RepoAgentStartRequest = z.infer<typeof RepoAgentStartRequestSchema>;

export { RepoAgentDecisionSchema };
export type RepoAgentDecision = z.infer<typeof RepoAgentDecisionSchema>;

export const RepoAgentDecideRequestSchema = z.discriminatedUnion('decision', [
  RepoAgentApproveDecisionSchema.extend({ runId: RepoAgentRunIdSchema }),
  RepoAgentDenyDecisionSchema.extend({ runId: RepoAgentRunIdSchema }),
  RepoAgentAbortDecisionSchema.extend({ runId: RepoAgentRunIdSchema }),
]);
export type RepoAgentDecideRequest = z.infer<typeof RepoAgentDecideRequestSchema>;
