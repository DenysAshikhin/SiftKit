import { z } from '../lib/zod.js';
import { ApprovalModeSchema } from '../repo-search/engine/approval-gate.js';

export const RepoAgentRunIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().nonnegative();
const UpdatedAtUtcSchema = z.string().datetime();
const ProcessIdSchema = z.number().int().positive();

const BaseStateFields = {
  runId: RepoAgentRunIdSchema,
  revision: RevisionSchema,
  updatedAtUtc: UpdatedAtUtcSchema,
};

export const RepoAgentRunRequestSchema = z.strictObject({
  runId: RepoAgentRunIdSchema,
  task: z.string().trim().min(1),
  repoRoot: z.string().min(1),
  model: z.string().min(1).optional(),
  logFile: z.string().min(1).optional(),
  approval: ApprovalModeSchema,
  images: z.array(z.string()).default([]),
});
export type RepoAgentRunRequest = z.infer<typeof RepoAgentRunRequestSchema>;

export const RepoAgentApprovalSchema = z.strictObject({
  approvalId: z.string().uuid(),
  toolName: z.string().min(1),
  command: z.string().min(1),
  reviewPayload: z.string().nullable(),
});
export type RepoAgentApproval = z.infer<typeof RepoAgentApprovalSchema>;

export const RepoAgentRunStateSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('starting'),
    pid: ProcessIdSchema,
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
    output: z.string().optional(),
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
    runId: RepoAgentRunIdSchema,
    output: z.string(),
  }),
  z.strictObject({
    status: z.literal('approval_required'),
    runId: RepoAgentRunIdSchema,
    approval: RepoAgentApprovalSchema,
    decide: z.strictObject({
      approve: z.string().min(1),
      deny: z.string().min(1),
      abort: z.string().min(1),
    }),
  }),
  z.strictObject({
    status: z.literal('approval_timeout'),
    runId: RepoAgentRunIdSchema,
    approval: RepoAgentApprovalSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    runId: RepoAgentRunIdSchema,
    error: z.string().min(1),
    output: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal('aborted'),
    runId: RepoAgentRunIdSchema,
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

export function buildRepoAgentDecideCommands(runId: string): {
  approve: string; deny: string; abort: string;
} {
  return {
    approve: `siftkit repo-agent decide ${runId} approve`,
    deny: `siftkit repo-agent decide ${runId} deny --reason "<why>"`,
    abort: `siftkit repo-agent decide ${runId} abort`,
  };
}

export function repoAgentStateToResult(state: RepoAgentRunState): RepoAgentRunResult {
  switch (state.status) {
    case 'completed':
      return RepoAgentRunResultSchema.parse({ status: 'completed', runId: state.runId, output: state.output });
    case 'approval_required':
      return RepoAgentRunResultSchema.parse({
        status: 'approval_required', runId: state.runId, approval: state.approval,
        decide: buildRepoAgentDecideCommands(state.runId),
      });
    case 'approval_timeout':
      return RepoAgentRunResultSchema.parse({ status: 'approval_timeout', runId: state.runId, approval: state.approval });
    case 'failed':
      return RepoAgentRunResultSchema.parse({
        status: 'failed',
        runId: state.runId,
        error: state.error,
        ...(state.output === undefined ? {} : { output: state.output }),
      });
    case 'aborted':
      return RepoAgentRunResultSchema.parse({ status: 'aborted', runId: state.runId });
    default:
      throw new Error(`Cannot convert ${state.status} to a public result.`);
  }
}
