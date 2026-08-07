import { z } from '../lib/zod.js';
import { ApprovalModeSchema } from '../repo-search/engine/approval-gate.js';

const RunIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().nonnegative();
const UpdatedAtUtcSchema = z.string().datetime();
const ProcessIdSchema = z.number().int().positive();

const BaseStateFields = {
  runId: RunIdSchema,
  revision: RevisionSchema,
  updatedAtUtc: UpdatedAtUtcSchema,
};

export const RepoAgentWorkerRequestSchema = z.strictObject({
  runId: RunIdSchema,
  task: z.string().trim().min(1),
  repoRoot: z.string().min(1),
  model: z.string().min(1).optional(),
  logFile: z.string().min(1).optional(),
  approval: ApprovalModeSchema,
  progress: z.boolean(),
  images: z.array(z.string()).default([]),
});
export type RepoAgentWorkerRequest = z.infer<typeof RepoAgentWorkerRequestSchema>;

export const RepoAgentApprovalSchema = z.strictObject({
  approvalId: z.string().uuid(),
  toolName: z.string().min(1),
  command: z.string().min(1),
  reviewPayload: z.string().nullable(),
});
export type RepoAgentApproval = z.infer<typeof RepoAgentApprovalSchema>;

const DecisionBaseFields = {
  runId: RunIdSchema,
  approvalId: z.string().uuid(),
  observedRevision: RevisionSchema,
};

export const RepoAgentDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...DecisionBaseFields,
    decision: z.literal('approve'),
  }),
  z.strictObject({
    ...DecisionBaseFields,
    decision: z.literal('deny'),
    reason: z.string().trim().min(1),
  }),
  z.strictObject({
    ...DecisionBaseFields,
    decision: z.literal('abort'),
  }),
]);
export type RepoAgentDecision = z.infer<typeof RepoAgentDecisionSchema>;

export const RepoAgentRunStateSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('starting'),
  }),
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('running'),
    pid: ProcessIdSchema,
  }),
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('approval_required'),
    pid: ProcessIdSchema,
    approval: RepoAgentApprovalSchema,
  }),
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('approval_timeout'),
    pid: ProcessIdSchema,
    approval: RepoAgentApprovalSchema,
  }),
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('completed'),
    pid: ProcessIdSchema,
    output: z.string(),
  }),
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('failed'),
    pid: ProcessIdSchema.optional(),
    error: z.string().min(1),
  }),
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('aborted'),
    pid: ProcessIdSchema,
  }),
]);
export type RepoAgentRunState = z.infer<typeof RepoAgentRunStateSchema>;

export const RepoAgentRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    runId: RunIdSchema,
    output: z.string(),
  }),
  z.strictObject({
    status: z.literal('approval_required'),
    runId: RunIdSchema,
    approval: RepoAgentApprovalSchema,
    decide: z.strictObject({
      approve: z.string().min(1),
      deny: z.string().min(1),
      abort: z.string().min(1),
    }),
  }),
  z.strictObject({
    status: z.literal('approval_timeout'),
    runId: RunIdSchema,
    approval: RepoAgentApprovalSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    runId: RunIdSchema,
    error: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal('aborted'),
    runId: RunIdSchema,
  }),
]);
export type RepoAgentRunResult = z.infer<typeof RepoAgentRunResultSchema>;

export function isTerminalStatus(status: RepoAgentRunState['status']): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'aborted'
    || status === 'approval_timeout';
}

export function isActiveStatus(status: RepoAgentRunState['status']): boolean {
  return !isTerminalStatus(status);
}
