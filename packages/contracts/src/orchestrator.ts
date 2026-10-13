import { z } from 'zod';

import {
  ApprovalModeSchema,
  RepoAgentAbortDecisionSchema,
  RepoAgentApprovalSchema,
  RepoAgentApproveDecisionSchema,
  RepoAgentDenyDecisionSchema,
  ToolActivityKindSchema,
} from './chat.ts';

/** Fixed policy: one initial dispatch plus one retry per purpose; not a configurable setting. */
export const ORCHESTRATOR_MAX_ATTEMPTS = 2;

export const OrchestratorChildPurposeSchema = z.enum(['implementation', 'drift_fix']);
export type OrchestratorChildPurpose = z.infer<typeof OrchestratorChildPurposeSchema>;

export const OrchestratorCommandCheckSchema = z.object({
  kind: z.literal('command'), command: z.string().trim().min(1),
  cwd: z.string().min(1), expectedExitCode: z.literal(0),
}).strict();
export type OrchestratorCommandCheck = z.infer<typeof OrchestratorCommandCheckSchema>;

export const OrchestratorVerificationCheckSchema = z.discriminatedUnion('kind', [
  OrchestratorCommandCheckSchema,
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

/** A claim anchored to repository code; the host checks the snippet sits at that line. */
export const OrchestratorCodeEvidenceSchema = z.object({
  path: z.string().min(1), line: z.number().int().positive(),
  snippet: z.string().trim().min(1),
}).strict();
export type OrchestratorCodeEvidence = z.infer<typeof OrchestratorCodeEvidenceSchema>;

export const OrchestratorDriftFindingSchema = z.object({
  id: z.string().trim().min(1), title: z.string().trim().min(1),
  purpose: z.string().trim().min(1), directive: z.string().trim().min(1),
  evidence: z.array(OrchestratorCodeEvidenceSchema).min(1),
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
  'preparing_plan', 'validating_plan', 'executing', 'verifying',
  'cleaning', 'approval_required', 'completed', 'failed', 'aborted', 'interrupted',
]);
export type OrchestratorPhase = z.infer<typeof OrchestratorPhaseSchema>;
export const ORCHESTRATOR_TERMINAL_PHASES = ['completed', 'failed', 'aborted', 'interrupted'] as const satisfies readonly OrchestratorPhase[];

export function isOrchestratorTerminalPhase(phase: OrchestratorPhase): boolean {
  return ORCHESTRATOR_TERMINAL_PHASES.some((terminal) => terminal === phase);
}

/** Task statuses that mean live work: the task holds its scheduler claim. */
const OrchestratorOpenTaskStatusSchema = z.enum(['running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending']);
export const OrchestratorTaskStatusSchema = z.enum([
  'pending', ...OrchestratorOpenTaskStatusSchema.options, 'completed', 'failed', 'aborted',
]);
export type OrchestratorTaskStatus = z.infer<typeof OrchestratorTaskStatusSchema>;

export function isOrchestratorOpenTaskStatus(status: OrchestratorTaskStatus): boolean {
  return OrchestratorOpenTaskStatusSchema.options.some((open) => open === status);
}

export const OrchestratorAttemptNumberSchema = z.number().int().min(1).max(ORCHESTRATOR_MAX_ATTEMPTS);

/** One declared check and what actually happened when it ran; `executed` false means it never ran. */
export const OrchestratorCheckResultSchema = z.object({
  check: OrchestratorVerificationCheckSchema,
  executed: z.boolean(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), output: z.string(),
}).strict();
export type OrchestratorCheckResult = z.infer<typeof OrchestratorCheckResultSchema>;

/** Why a command check failed, or null; evidence checks are judged by the review, never here. */
export function orchestratorCheckFailure(result: OrchestratorCheckResult): string | null {
  if (result.check.kind !== 'command') return null;
  const command = `Check \`${result.check.command}\``;
  if (!result.executed) return `${command} never ran.`;
  if (result.timedOut) return `${command} timed out.`;
  if (result.exitCode !== result.check.expectedExitCode) {
    return `${command} exited ${result.exitCode ?? 'unknown'}; expected ${result.check.expectedExitCode}.`;
  }
  return null;
}

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
  status: z.enum(['reserved', 'running', 'settled', 'abandoned']), result: OrchestratorAttemptResultSchema.nullable(),
  reservedAtUtc: z.string().datetime(),
}).strict();
export type OrchestratorAttempt = z.infer<typeof OrchestratorAttemptSchema>;

/** The run's one pending approval: a parked child's tool call, or one orchestrator check command. */
export const OrchestratorPendingApprovalSchema = z.discriminatedUnion('kind', [
  RepoAgentApprovalSchema.extend({ kind: z.literal('child'), childRunId: z.string().uuid(), taskId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('check'), approvalId: z.string().uuid(), taskId: z.string().min(1).nullable(),
    command: z.string().trim().min(1), cwd: z.string().min(1) }).strict(),
]);
export type OrchestratorPendingApproval = z.infer<typeof OrchestratorPendingApprovalSchema>;

export const OrchestratorFailureCodeSchema = z.enum([
  'aborted', 'interrupted', 'internal_error', 'infrastructure_failed', 'blocked', 'cleanup_failed',
  'plan_not_found', 'plan_blocked', 'plan_invalid', 'implementation_failed', 'task_review_invalid',
  'drift_review_invalid', 'drift_unresolved', 'approval_decision_invalid', 'final_review_invalid', 'final_verification_failed',
]);
export type OrchestratorFailureCode = z.infer<typeof OrchestratorFailureCodeSchema>;

export const OrchestratorFailureSchema = z.object({
  code: OrchestratorFailureCodeSchema, message: z.string().min(1),
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

/** One stream frame: the events committed since the previous frame and the state they produced. */
export const OrchestratorProgressSchema = z.object({
  events: z.array(OrchestratorEventSchema).min(1), state: OrchestratorRunStateSchema,
}).strict();
export type OrchestratorProgress = z.infer<typeof OrchestratorProgressSchema>;

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
  z.object({ status: z.literal('pass'), evidence: z.array(OrchestratorCodeEvidenceSchema).min(1) }).strict(),
  z.object({ status: z.literal('fail'), findings: z.array(OrchestratorReviewFindingSchema).min(1) }).strict(),
]);
export type OrchestratorTaskReview = z.infer<typeof OrchestratorTaskReviewSchema>;

/** The parent's answer to a subagent's permission request or to one of its own check commands. */
export const OrchestratorApprovalDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), reason: z.string().trim().min(1) }).strict(),
  z.object({ decision: z.literal('deny'), reason: z.string().trim().min(1) }).strict(),
]);
export type OrchestratorApprovalDecision = z.infer<typeof OrchestratorApprovalDecisionSchema>;

/** One reserved child to start; its purpose is `work.kind`. */
export const OrchestratorChildRequestSchema = z.object({
  runId: z.string().uuid(), taskId: z.string().min(1), attempt: OrchestratorAttemptNumberSchema,
  childRunId: z.string().uuid(), workerPresetId: z.string().trim().min(1), repoRoot: z.string().min(1),
  work: OrchestratorChildWorkSchema, instruction: z.string().trim().min(1), approval: ApprovalModeSchema,
}).strict();
export type OrchestratorChildRequest = z.infer<typeof OrchestratorChildRequestSchema>;

/** A repo-agent decision addressed to the run's one recorded pending approval. */
const DecisionAddress = { runId: z.string().uuid(), approvalId: z.string().uuid() };
export const OrchestratorDecideRequestSchema = z.discriminatedUnion('decision', [
  RepoAgentApproveDecisionSchema.extend(DecisionAddress).strict(),
  RepoAgentDenyDecisionSchema.extend(DecisionAddress).strict(),
  RepoAgentAbortDecisionSchema.extend(DecisionAddress).strict(),
]);
export type OrchestratorDecideRequest = z.infer<typeof OrchestratorDecideRequestSchema>;

export const OrchestratorAbortRequestSchema = z.object({ runId: z.string().uuid() }).strict();
export type OrchestratorAbortRequest = z.infer<typeof OrchestratorAbortRequestSchema>;

export const OrchestratorRunListSchema = z.object({ runs: z.array(OrchestratorRunStateSchema) }).strict();
export type OrchestratorRunList = z.infer<typeof OrchestratorRunListSchema>;

/** How many of a child's latest tool calls the live view keeps. */
export const ORCHESTRATOR_RECENT_TOOL_LIMIT = 4;
/** SSE frame name for live, unpersisted activity on the orchestrator events stream. */
export const ORCHESTRATOR_ACTIVITY_FRAME = 'activity';

export const OrchestratorToolCallActivitySchema = z.object({
  toolCallId: z.string().min(1), turn: z.number().int().positive(), activityKind: ToolActivityKindSchema,
  command: z.string(), status: z.enum(['running', 'succeeded', 'failed']),
}).strict();
export type OrchestratorToolCallActivity = z.infer<typeof OrchestratorToolCallActivitySchema>;

/** A running child as the parent observes it; in memory only, dropped when the child settles. */
export const OrchestratorChildActivitySchema = z.object({
  childRunId: z.string().uuid(), taskId: z.string().min(1),
  waitingForModel: z.boolean(), turn: z.number().int().nonnegative(), maxTurns: z.number().int().positive().nullable(),
  promptTokens: z.number().nonnegative(),
  tools: z.array(OrchestratorToolCallActivitySchema).max(ORCHESTRATOR_RECENT_TOOL_LIMIT),
}).strict();
export type OrchestratorChildActivity = z.infer<typeof OrchestratorChildActivitySchema>;

/** What a task claims from the scheduler: one slot of its worker's model, and the writer slot if it mutates. */
export const OrchestratorTaskClaimSchema = z.object({
  taskId: z.string().min(1), modelId: z.string().min(1), mutating: z.boolean(), contextTokens: z.number().positive(),
}).strict();
export type OrchestratorTaskClaim = z.infer<typeof OrchestratorTaskClaimSchema>;

export const OrchestratorModelSlotsSchema = z.object({
  modelId: z.string().min(1), slots: z.number().positive(), used: z.number().int().nonnegative(),
}).strict();
export type OrchestratorModelSlots = z.infer<typeof OrchestratorModelSlotsSchema>;

/** Why the scheduler left a ready-to-check pending task waiting, in the order it checks. */
export const OrchestratorTaskWaitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dependencies'), taskIds: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal('writer_slot') }).strict(),
  z.object({ kind: z.literal('model_slot'), modelId: z.string().min(1) }).strict(),
]);
export type OrchestratorTaskWait = z.infer<typeof OrchestratorTaskWaitSchema>;

/** The latest scheduler pass: every task's claim, the slots held after it, and why each pending task waits. */
export const OrchestratorScheduleSchema = z.object({
  claims: z.array(OrchestratorTaskClaimSchema), models: z.array(OrchestratorModelSlotsSchema), writerUsed: z.boolean(),
  waits: z.array(z.object({ taskId: z.string().min(1), wait: OrchestratorTaskWaitSchema }).strict()),
}).strict();
export type OrchestratorSchedule = z.infer<typeof OrchestratorScheduleSchema>;

/** The parent's live view; the schedule is null until the scheduler's first pass. */
export const OrchestratorActivitySchema = z.object({
  runId: z.string().uuid(), schedule: OrchestratorScheduleSchema.nullable(), children: z.array(OrchestratorChildActivitySchema),
}).strict();
export type OrchestratorActivity = z.infer<typeof OrchestratorActivitySchema>;
