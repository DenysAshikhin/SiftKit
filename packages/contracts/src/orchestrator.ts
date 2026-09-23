import { z } from 'zod';

import { ApprovalModeSchema, RepoAgentApprovalSchema } from './chat.js';

/** Fixed policy: one initial dispatch plus one retry per purpose; not a configurable setting. */
export const ORCHESTRATOR_MAX_ATTEMPTS = 2;

export const OrchestratorChildPurposeSchema = z.enum(['implementation', 'drift_fix']);
export type OrchestratorChildPurpose = z.infer<typeof OrchestratorChildPurposeSchema>;

export const OrchestratorVerificationCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'), command: z.string().trim().min(1),
    cwd: z.string().min(1), expectedExitCode: z.literal(0),
  }).strict(),
  z.object({
    kind: z.literal('evidence'), instruction: z.string().trim().min(1),
    paths: z.array(z.string().min(1)).min(1),
  }).strict(),
]);
export type OrchestratorVerificationCheck = z.infer<typeof OrchestratorVerificationCheckSchema>;

export const OrchestratorTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().trim().min(1),
  dependsOn: z.array(z.string().min(1)),
  workerPresetId: z.string().trim().min(1),
  readPaths: z.array(z.string().min(1)),
  writePaths: z.array(z.string().min(1)),
  steps: z.array(z.object({
    instruction: z.string().trim().min(1), expectedResult: z.string().trim().min(1),
  }).strict()).min(1),
  verification: z.array(OrchestratorVerificationCheckSchema).min(1),
  acceptance: z.array(z.string().trim().min(1)).min(1),
  temporaryPaths: z.array(z.string().min(1)),
}).strict();
export type OrchestratorTask = z.infer<typeof OrchestratorTaskSchema>;

export const OrchestratorPlanSchema = z.object({
  goal: z.string().trim().min(1), constraints: z.array(z.string().min(1)),
  tasks: z.array(OrchestratorTaskSchema).min(1),
  finalVerification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorPlan = z.infer<typeof OrchestratorPlanSchema>;

const DriftCodeEvidenceSchema = z.object({
  path: z.string().min(1), line: z.number().int().positive(),
  snippet: z.string().trim().min(1),
}).strict();

export const OrchestratorDriftFindingSchema = z.object({
  id: z.string().trim().min(1), title: z.string().trim().min(1),
  purpose: z.string().trim().min(1), directive: z.string().trim().min(1),
  evidence: z.array(DriftCodeEvidenceSchema).min(1),
  impact: z.string().trim().min(1), fix: z.string().trim().min(1),
  affectedPaths: z.array(z.string().min(1)).min(1),
  verification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorDriftFinding = z.infer<typeof OrchestratorDriftFindingSchema>;

const DriftReviewFields = {
  taskId: z.string().min(1), changeDigest: z.string().min(1),
  scopePaths: z.array(z.string().min(1)),
  resolutions: z.array(z.object({
    findingId: z.string().min(1), evidence: z.string().trim().min(1),
  }).strict()),
};
export const OrchestratorDriftReviewSchema = z.discriminatedUnion('status', [
  z.object({ ...DriftReviewFields, status: z.literal('not_required'),
    reason: z.literal('no_code_changes') }).strict(),
  z.object({ ...DriftReviewFields, status: z.literal('clean'),
    findings: z.array(OrchestratorDriftFindingSchema).max(0) }).strict(),
  z.object({ ...DriftReviewFields, status: z.literal('actionable'),
    findings: z.array(OrchestratorDriftFindingSchema).min(1) }).strict(),
]);
export type OrchestratorDriftReview = z.infer<typeof OrchestratorDriftReviewSchema>;

export const OrchestratorDriftCorrectionWorkSchema = z.object({
  kind: z.literal('drift_fix'), taskId: z.string().min(1),
  objective: z.string().trim().min(1), changeDigest: z.string().min(1),
  findings: z.array(OrchestratorDriftFindingSchema).min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  verification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorDriftCorrectionWork = z.infer<typeof OrchestratorDriftCorrectionWorkSchema>;

export const OrchestratorChildWorkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('implementation'), planPath: z.string().min(1),
    planHash: z.string().min(1), task: OrchestratorTaskSchema }).strict(),
  OrchestratorDriftCorrectionWorkSchema,
]);
export type OrchestratorChildWork = z.infer<typeof OrchestratorChildWorkSchema>;

export const OrchestratorStartRequestSchema = z.object({
  submissionId: z.string().uuid(),
  repoRoot: z.string().trim().min(1),
  presetId: z.string().trim().min(1),
  approval: ApprovalModeSchema,
  task: z.string().trim().min(1).nullable(),
  planPath: z.string().trim().min(1).nullable(),
}).strict().refine((request) => request.task !== null || request.planPath !== null, {
  message: 'An orchestrator run needs a task, a plan path, or both.',
});
export type OrchestratorStartRequest = z.infer<typeof OrchestratorStartRequestSchema>;

export const OrchestratorPhaseSchema = z.enum([
  'preparing_plan', 'validating_plan', 'executing', 'verifying', 'reviewing_drift', 'correcting_drift',
  'cleaning', 'approval_required', 'completed', 'failed', 'aborted', 'interrupted',
]);
export type OrchestratorPhase = z.infer<typeof OrchestratorPhaseSchema>;
export const ORCHESTRATOR_TERMINAL_PHASES = ['completed', 'failed', 'aborted', 'interrupted'] as const satisfies readonly OrchestratorPhase[];

export function isOrchestratorTerminalPhase(phase: OrchestratorPhase): boolean {
  return ORCHESTRATOR_TERMINAL_PHASES.some((terminal) => terminal === phase);
}

export const OrchestratorTaskStatusSchema = z.enum([
  'pending', 'running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending', 'completed', 'failed', 'aborted',
]);
export type OrchestratorTaskStatus = z.infer<typeof OrchestratorTaskStatusSchema>;

export const OrchestratorAttemptNumberSchema = z.number().int().min(1).max(ORCHESTRATOR_MAX_ATTEMPTS);

/** One declared check and what actually happened when it ran; `executed` false means it never ran. */
export const OrchestratorCheckResultSchema = z.object({
  check: OrchestratorVerificationCheckSchema,
  executed: z.boolean(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), output: z.string(),
}).strict();
export type OrchestratorCheckResult = z.infer<typeof OrchestratorCheckResultSchema>;

/** A worker's terminal status, reusing the repo-agent terminal vocabulary. */
export const OrchestratorWorkerStatusSchema = z.enum(['completed', 'failed', 'aborted', 'approval_timeout']);
export type OrchestratorWorkerStatus = z.infer<typeof OrchestratorWorkerStatusSchema>;

export const OrchestratorAttemptResultSchema = z.object({
  taskId: z.string().min(1), purpose: OrchestratorChildPurposeSchema, attempt: OrchestratorAttemptNumberSchema,
  childRunId: z.string().uuid(), workerStatus: OrchestratorWorkerStatusSchema, workerOutput: z.string(),
  passed: z.boolean(), checks: z.array(OrchestratorCheckResultSchema),
  findings: z.array(z.string().trim().min(1)), changedPaths: z.array(z.string().min(1)),
  scopeViolations: z.array(z.string().min(1)), changeDigest: z.string().min(1).nullable(),
}).strict();
export type OrchestratorAttemptResult = z.infer<typeof OrchestratorAttemptResultSchema>;

export const OrchestratorAttemptSchema = z.object({
  taskId: z.string().min(1), purpose: OrchestratorChildPurposeSchema, attempt: OrchestratorAttemptNumberSchema,
  childRunId: z.string().uuid(), work: OrchestratorChildWorkSchema,
  status: z.enum(['reserved', 'running', 'settled']), result: OrchestratorAttemptResultSchema.nullable(),
  reservedAtUtc: z.string().datetime(),
}).strict();
export type OrchestratorAttempt = z.infer<typeof OrchestratorAttemptSchema>;

export const OrchestratorApprovalTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phase'), phaseRunId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('child'), childRunId: z.string().uuid() }).strict(),
]);
export type OrchestratorApprovalTarget = z.infer<typeof OrchestratorApprovalTargetSchema>;

export const OrchestratorPendingApprovalSchema = z.object({
  target: OrchestratorApprovalTargetSchema, taskId: z.string().min(1).nullable(), approval: RepoAgentApprovalSchema,
}).strict();
export type OrchestratorPendingApproval = z.infer<typeof OrchestratorPendingApprovalSchema>;

export const OrchestratorFailureSchema = z.object({
  code: z.string().min(1), message: z.string().min(1),
  taskId: z.string().nullable(), purpose: OrchestratorChildPurposeSchema.nullable(),
  findingIds: z.array(z.string().min(1)),
}).strict();
export type OrchestratorFailure = z.infer<typeof OrchestratorFailureSchema>;

export const OrchestratorTaskStateSchema = z.object({
  taskId: z.string().min(1), status: OrchestratorTaskStatusSchema,
  driftReview: OrchestratorDriftReviewSchema.nullable(), reviewedDigests: z.array(z.string().min(1)),
}).strict();
export type OrchestratorTaskState = z.infer<typeof OrchestratorTaskStateSchema>;

export const OrchestratorRunStateSchema = z.object({
  runId: z.string().uuid(), request: OrchestratorStartRequestSchema, revision: z.number().int().nonnegative(),
  phase: OrchestratorPhaseSchema, planPath: z.string().min(1).nullable(), planHash: z.string().min(1).nullable(),
  plan: OrchestratorPlanSchema.nullable(), tasks: z.array(OrchestratorTaskStateSchema),
  attempts: z.array(OrchestratorAttemptSchema), phaseRunIds: z.array(z.string().uuid()),
  approval: OrchestratorPendingApprovalSchema.nullable(), failure: OrchestratorFailureSchema.nullable(),
  createdAtUtc: z.string().datetime(), updatedAtUtc: z.string().datetime(),
}).strict();
export type OrchestratorRunState = z.infer<typeof OrchestratorRunStateSchema>;

/** A committed state change; clients replay these by sequence and never see an uncommitted one. */
export const OrchestratorEventSchema = z.object({
  runId: z.string().uuid(), sequence: z.number().int().positive(), atUtc: z.string().datetime(),
  phase: OrchestratorPhaseSchema, message: z.string().min(1), taskId: z.string().min(1).nullable(),
  purpose: OrchestratorChildPurposeSchema.nullable(), attempt: OrchestratorAttemptNumberSchema.nullable(),
  childRunId: z.string().uuid().nullable(),
}).strict();
export type OrchestratorEvent = z.infer<typeof OrchestratorEventSchema>;

/** Parent plan preparation: keep a supplied plan, write a generated/rewritten one, or stop with a reason. */
export const OrchestratorPlanPreparationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), plan: OrchestratorPlanSchema }).strict(),
  z.object({ status: z.literal('generated'), plan: OrchestratorPlanSchema,
    issues: z.array(z.string().trim().min(1)) }).strict(),
  z.object({ status: z.literal('blocked'), reason: z.string().trim().min(1) }).strict(),
]);
export type OrchestratorPlanPreparation = z.infer<typeof OrchestratorPlanPreparationSchema>;

export const OrchestratorReviewFindingSchema = z.object({
  path: z.string().min(1), line: z.number().int().positive(), issue: z.string().trim().min(1),
}).strict();
export type OrchestratorReviewFinding = z.infer<typeof OrchestratorReviewFindingSchema>;

/** A parent acceptance review of recorded evidence; a failure must anchor what is wrong. */
export const OrchestratorTaskReviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pass'), evidence: z.array(z.string().trim().min(1)).min(1) }).strict(),
  z.object({ status: z.literal('fail'), findings: z.array(OrchestratorReviewFindingSchema).min(1) }).strict(),
]);
export type OrchestratorTaskReview = z.infer<typeof OrchestratorTaskReviewSchema>;

/** The parent's answer to a subagent's permission request. */
export const OrchestratorChildApprovalDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), reason: z.string().trim().min(1) }).strict(),
  z.object({ decision: z.literal('deny'), reason: z.string().trim().min(1) }).strict(),
]);
export type OrchestratorChildApprovalDecision = z.infer<typeof OrchestratorChildApprovalDecisionSchema>;

/** One reserved child to start; its purpose is `work.kind`. */
export const OrchestratorChildRequestSchema = z.object({
  runId: z.string().uuid(), taskId: z.string().min(1), attempt: OrchestratorAttemptNumberSchema,
  childRunId: z.string().uuid(), workerPresetId: z.string().trim().min(1), repoRoot: z.string().min(1),
  work: OrchestratorChildWorkSchema, instruction: z.string().trim().min(1), approval: ApprovalModeSchema,
}).strict();
export type OrchestratorChildRequest = z.infer<typeof OrchestratorChildRequestSchema>;

/** A decision for the parent's one recorded pending approval (a parent phase or a child). */
export const OrchestratorDecideRequestSchema = z.discriminatedUnion('decision', [
  z.object({ runId: z.string().uuid(), approvalId: z.string().uuid(), decision: z.literal('approve') }).strict(),
  z.object({ runId: z.string().uuid(), approvalId: z.string().uuid(), decision: z.literal('deny'),
    reason: z.string().trim().min(1) }).strict(),
  z.object({ runId: z.string().uuid(), approvalId: z.string().uuid(), decision: z.literal('abort') }).strict(),
]);
export type OrchestratorDecideRequest = z.infer<typeof OrchestratorDecideRequestSchema>;

export const OrchestratorAbortRequestSchema = z.object({ runId: z.string().uuid() }).strict();
export type OrchestratorAbortRequest = z.infer<typeof OrchestratorAbortRequestSchema>;

export const OrchestratorRunListSchema = z.object({ runs: z.array(OrchestratorRunStateSchema) }).strict();
export type OrchestratorRunList = z.infer<typeof OrchestratorRunListSchema>;
