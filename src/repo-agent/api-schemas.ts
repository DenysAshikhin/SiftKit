import { ImageDataUrlSchema } from '@siftkit/contracts';

import { z } from '../lib/zod.js';
import { ApprovalModeSchema } from '../repo-search/engine/approval-gate.js';
import { RepoSearchMockCommandResultSchema } from '../repo-search/types.js';
import { RepoAgentRunIdSchema } from './run-schemas.js';

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
  mockResponses: z.array(z.string()).optional(),
  mockCommandResults: z.record(z.string(), RepoSearchMockCommandResultSchema).optional(),
});
export type RepoAgentStartRequest = z.infer<typeof RepoAgentStartRequestSchema>;

const RepoAgentApproveDecisionSchema = z.strictObject({ decision: z.literal('approve') });
const RepoAgentDenyDecisionSchema = z.strictObject({
  decision: z.literal('deny'),
  reason: z.string().trim().min(1),
});
const RepoAgentAbortDecisionSchema = z.strictObject({ decision: z.literal('abort') });

export const RepoAgentDecisionSchema = z.discriminatedUnion('decision', [
  RepoAgentApproveDecisionSchema,
  RepoAgentDenyDecisionSchema,
  RepoAgentAbortDecisionSchema,
]);
export type RepoAgentDecision = z.infer<typeof RepoAgentDecisionSchema>;

export const RepoAgentDecideRequestSchema = z.discriminatedUnion('decision', [
  RepoAgentApproveDecisionSchema.extend({ runId: RepoAgentRunIdSchema }),
  RepoAgentDenyDecisionSchema.extend({ runId: RepoAgentRunIdSchema }),
  RepoAgentAbortDecisionSchema.extend({ runId: RepoAgentRunIdSchema }),
]);
export type RepoAgentDecideRequest = z.infer<typeof RepoAgentDecideRequestSchema>;
