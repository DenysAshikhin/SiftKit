import { z } from 'zod';

import {
  ApprovalModeSchema,
  RepoAgentAbortDecisionSchema,
  RepoAgentApprovalSchema,
  RepoAgentApproveDecisionSchema,
  RepoAgentDenyDecisionSchema,
  ToolActivityKindSchema,
} from './chat.ts';

/** Fixed policy: fresh children per task and purpose; not a configurable setting. */
export const ORCHESTRATOR_MAX_ATTEMPTS = 2;
/** Fixed policy: how often one child may resubmit after its checks fail, inside its own session. */
export const ORCHESTRATOR_MAX_RESUBMITS = 2;

/** Two weeks; it also keeps a run's deadline inside one timer. */
export const ORCHESTRATOR_MAX_BUDGET_MINUTES = 20_160;

/** A run's whole allowance: the minutes after which it is stopped, and how many children it may start. */
export const OrchestratorBudgetSchema = z.object({
  minutes: z.number().positive().max(ORCHESTRATOR_MAX_BUDGET_MINUTES), dispatches: z.number().int().positive(),
}).strict();
export type OrchestratorBudget = z.infer<typeof OrchestratorBudgetSchema>;

/** What a start uses when it names no budget: room for a long multi-task run. */
export const DEFAULT_ORCHESTRATOR_BUDGET: OrchestratorBudget = { minutes: 720, dispatches: 80 };

/** `implementation` builds a task; `fix` repairs a task the orchestrator's review failed. */
export const OrchestratorChildPurposeSchema = z.enum(['implementation', 'fix']);
export type OrchestratorChildPurpose = z.infer<typeof OrchestratorChildPurposeSchema>;

export const OrchestratorCommandCheckSchema = z.object({
  kind: z.literal('command'), command: z.string().trim().min(1),
  cwd: z.string().min(1).default('.'), expectedExitCode: z.literal(0).default(0),
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

/** A plan task's fields exactly as written; update_tasks patches use this shape so a patch never gains a default. */
const OrchestratorTaskFieldsSchema = z.object({
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

/** A plan task; omitted dependency, read, and temporary lists mean none. */
export const OrchestratorTaskSchema = OrchestratorTaskFieldsSchema.extend({
  dependsOn: OrchestratorTaskFieldsSchema.shape.dependsOn.default([]),
  readPaths: OrchestratorTaskFieldsSchema.shape.readPaths.default([]),
  temporaryPaths: OrchestratorTaskFieldsSchema.shape.temporaryPaths.default([]),
}).strict();
export type OrchestratorTask = z.infer<typeof OrchestratorTaskSchema>;

/** The stored plan. After a rollback it may hold no task until the next approach adds some. */
export const OrchestratorPlanSchema = z.object({
  goal: z.string().trim().min(1), constraints: z.array(z.string().min(1)),
  tasks: z.array(OrchestratorTaskSchema),
  finalVerification: z.array(OrchestratorVerificationCheckSchema).min(1),
}).strict();
export type OrchestratorPlan = z.infer<typeof OrchestratorPlanSchema>;

/** A claim anchored to repository code; the host checks the snippet sits at that line. */
export const OrchestratorCodeEvidenceSchema = z.object({
  path: z.string().min(1), line: z.number().int().positive(),
  snippet: z.string().trim().min(1),
}).strict();
export type OrchestratorCodeEvidence = z.infer<typeof OrchestratorCodeEvidenceSchema>;

/** A claim proven by a command that passed: an attempt check, or the orchestrator's run_check since the report. */
export const OrchestratorCommandEvidenceSchema = z.object({ command: z.string().trim().min(1) }).strict();
export type OrchestratorCommandEvidence = z.infer<typeof OrchestratorCommandEvidenceSchema>;

export const OrchestratorCriterionEvidenceSchema = z.union([OrchestratorCodeEvidenceSchema, OrchestratorCommandEvidenceSchema]);
export type OrchestratorCriterionEvidence = z.infer<typeof OrchestratorCriterionEvidenceSchema>;

/** One fresh child's assignment: the plan task, and the orchestrator's own instruction for this attempt. */
export const OrchestratorChildWorkSchema = z.object({
  kind: OrchestratorChildPurposeSchema, planPath: z.string().min(1), planHash: z.string().min(1),
  task: OrchestratorTaskSchema, instruction: z.string().trim().min(1),
}).strict();
export type OrchestratorChildWork = z.infer<typeof OrchestratorChildWorkSchema>;

export const OrchestratorStartRequestSchema = z.object({
  submissionId: z.string().uuid(),
  /** The chat session the run belongs to; null when the start came from no session and needs one. */
  sessionId: z.string().uuid().nullable(),
  repoRoot: z.string().trim().min(1),
  presetId: z.string().trim().min(1),
  approval: ApprovalModeSchema,
  budget: OrchestratorBudgetSchema,
  task: z.string().trim().min(1).nullable(),
  planPath: z.string().trim().min(1).nullable(),
}).strict().refine((request) => request.task !== null || request.planPath !== null, {
  message: 'An orchestrator run needs a task, a plan path, or both.',
});
export type OrchestratorStartRequest = z.infer<typeof OrchestratorStartRequestSchema>;

export const OrchestratorPhaseSchema = z.enum([
  'preparing_plan', 'executing', 'verifying',
  'cleaning', 'approval_required', 'completed', 'failed', 'aborted', 'interrupted',
]);
export type OrchestratorPhase = z.infer<typeof OrchestratorPhaseSchema>;
export const ORCHESTRATOR_TERMINAL_PHASES = ['completed', 'failed', 'aborted', 'interrupted'] as const satisfies readonly OrchestratorPhase[];

export function isOrchestratorTerminalPhase(phase: OrchestratorPhase): boolean {
  return ORCHESTRATOR_TERMINAL_PHASES.some((terminal) => terminal === phase);
}

/** Task statuses that mean live work: a child runs, or its report waits for the orchestrator's review. */
const OrchestratorOpenTaskStatusSchema = z.enum(['running', 'reviewing']);
export const OrchestratorTaskStatusSchema = z.enum([
  'pending', ...OrchestratorOpenTaskStatusSchema.options, 'completed', 'failed', 'aborted',
]);
export type OrchestratorTaskStatus = z.infer<typeof OrchestratorTaskStatusSchema>;

export function isOrchestratorOpenTaskStatus(status: OrchestratorTaskStatus): boolean {
  return OrchestratorOpenTaskStatusSchema.options.some((open) => open === status);
}

export const OrchestratorAttemptNumberSchema = z.number().int().min(1).max(ORCHESTRATOR_MAX_ATTEMPTS);

/** One declared check and what happened when it ran; `executed` false means it never ran, and `digest` digests its whole output. */
export const OrchestratorCheckResultSchema = z.object({
  check: OrchestratorVerificationCheckSchema,
  executed: z.boolean(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), output: z.string(),
  digest: z.string().nullable(),
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

const ReportIndexSchema = z.number().int().nonnegative();

/** A worker's outcome: whether it finished, and where it departed from the plan and why. The host attaches the measured facts. */
export const OrchestratorHandoffReportSchema = z.object({
  status: z.enum(['completed', 'incomplete']),
  deviations: z.array(z.object({ what: z.string().trim().min(1), why: z.string().trim().min(1) }).strict()),
}).strict();
export type OrchestratorHandoffReport = z.infer<typeof OrchestratorHandoffReportSchema>;

/** How a child's submissions ended: its checks passed, they still failed when resubmits ran out, or no usable report came. */
export const OrchestratorSubmissionOutcomeSchema = z.enum(['passed', 'checks_failed', 'report_invalid', 'not_submitted']);
export type OrchestratorSubmissionOutcome = z.infer<typeof OrchestratorSubmissionOutcomeSchema>;

export const OrchestratorAttemptResultSchema = z.object({
  taskId: z.string().min(1), purpose: OrchestratorChildPurposeSchema, attempt: OrchestratorAttemptNumberSchema,
  childRunId: z.string().uuid(), workerStatus: OrchestratorWorkerStatusSchema, workerOutput: z.string(),
  report: OrchestratorHandoffReportSchema.nullable(), outcome: OrchestratorSubmissionOutcomeSchema,
  submissions: z.number().int().nonnegative().max(ORCHESTRATOR_MAX_RESUBMITS + 1),
  passed: z.boolean(), checks: z.array(OrchestratorCheckResultSchema),
  findings: z.array(z.string().trim().min(1)), changedPaths: z.array(z.string().min(1)),
  changeDigest: z.string().min(1).nullable(),
}).strict();
export type OrchestratorAttemptResult = z.infer<typeof OrchestratorAttemptResultSchema>;

export const OrchestratorAttemptSchema = z.object({
  taskId: z.string().min(1), purpose: OrchestratorChildPurposeSchema, attempt: OrchestratorAttemptNumberSchema,
  childRunId: z.string().uuid(), work: OrchestratorChildWorkSchema,
  status: z.enum(['reserved', 'running', 'settled', 'abandoned']), result: OrchestratorAttemptResultSchema.nullable(),
  reservedAtUtc: z.string().datetime(),
}).strict();
export type OrchestratorAttempt = z.infer<typeof OrchestratorAttemptSchema>;

/** Whether `taskId` has used every attempt of `purpose`. Attempts are never refunded. */
export function orchestratorAttemptsSpent(attempts: readonly Pick<OrchestratorAttempt, 'taskId' | 'purpose'>[], taskId: string,
  purpose: OrchestratorChildPurpose): boolean {
  return attempts.filter((attempt) => attempt.taskId === taskId && attempt.purpose === purpose).length >= ORCHESTRATOR_MAX_ATTEMPTS;
}

/** The run's one pending approval: a child's escalated tool call, or one orchestrator check command. */
export const OrchestratorPendingApprovalSchema = z.discriminatedUnion('kind', [
  RepoAgentApprovalSchema.extend({ kind: z.literal('child'), childRunId: z.string().uuid(), taskId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('check'), approvalId: z.string().uuid(), taskId: z.string().min(1).nullable(),
    command: z.string().trim().min(1), cwd: z.string().min(1) }).strict(),
]);
export type OrchestratorPendingApproval = z.infer<typeof OrchestratorPendingApprovalSchema>;

export const OrchestratorFailureCodeSchema = z.enum([
  'aborted', 'interrupted', 'internal_error', 'infrastructure_failed', 'blocked', 'cleanup_failed',
  'plan_not_found', 'orchestrator_incomplete', 'budget_exhausted',
]);
export type OrchestratorFailureCode = z.infer<typeof OrchestratorFailureCodeSchema>;

export const OrchestratorFailureSchema = z.object({
  code: OrchestratorFailureCodeSchema, message: z.string().min(1), taskId: z.string().nullable(),
}).strict();
export type OrchestratorFailure = z.infer<typeof OrchestratorFailureSchema>;

export const OrchestratorReviewFindingSchema = z.object({
  path: z.string().min(1), line: z.number().int().positive(), issue: z.string().trim().min(1),
}).strict();
export type OrchestratorReviewFinding = z.infer<typeof OrchestratorReviewFindingSchema>;

/** The orchestrator's judgement of every acceptance criterion of one settled attempt. */
export const OrchestratorReviewRecordSchema = z.object({
  attempt: OrchestratorAttemptNumberSchema, purpose: OrchestratorChildPurposeSchema, verdict: z.enum(['pass', 'fail']),
  criteria: z.array(z.object({
    index: ReportIndexSchema, met: z.boolean(), evidence: z.array(OrchestratorCriterionEvidenceSchema),
  }).strict()),
  findings: z.array(OrchestratorReviewFindingSchema),
}).strict();
export type OrchestratorReviewRecord = z.infer<typeof OrchestratorReviewRecordSchema>;

/** One way of reaching the goal: the tasks added while it was active, and how it ended. */
export const OrchestratorApproachSchema = z.object({
  number: z.number().int().positive(), title: z.string().trim().min(1), startedAtUtc: z.string().datetime(),
  /** Null while active; `rolled_back` put the files back as they were when the approach began. */
  outcome: z.object({
    kind: z.enum(['kept', 'rolled_back']), lesson: z.string().trim().min(1), endedAtUtc: z.string().datetime(),
  }).strict().nullable(),
}).strict();
export type OrchestratorApproach = z.infer<typeof OrchestratorApproachSchema>;

/** A task taken out of the plan after it ran, kept so the same thing is not tried twice unknowingly. */
export const OrchestratorRetiredTaskSchema = z.object({
  taskId: z.string().min(1), title: z.string().trim().min(1), approach: z.number().int().positive(),
  status: OrchestratorTaskStatusSchema, reason: z.string().trim().min(1), retiredAtUtc: z.string().datetime(),
}).strict();
export type OrchestratorRetiredTask = z.infer<typeof OrchestratorRetiredTaskSchema>;

export const OrchestratorTaskStateSchema = z.object({
  taskId: z.string().min(1), status: OrchestratorTaskStatusSchema, review: OrchestratorReviewRecordSchema.nullable(),
  /** The approach that was active when the task was added, or the one it was carried into. */
  approach: z.number().int().positive(),
}).strict();
export type OrchestratorTaskState = z.infer<typeof OrchestratorTaskStateSchema>;

export const OrchestratorRunStateSchema = z.object({
  runId: z.string().uuid(), request: OrchestratorStartRequestSchema, revision: z.number().int().nonnegative(),
  phase: OrchestratorPhaseSchema, planPath: z.string().min(1).nullable(), planHash: z.string().min(1).nullable(),
  plan: OrchestratorPlanSchema.nullable(), tasks: z.array(OrchestratorTaskStateSchema),
  approaches: z.array(OrchestratorApproachSchema), retiredTasks: z.array(OrchestratorRetiredTaskSchema),
  attempts: z.array(OrchestratorAttemptSchema), parentRunIds: z.array(z.string().uuid()),
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

// ---- the orchestrator's own tools ----

/** The first plan, as save_plan takes it: at least one task. */
export const OrchestratorSavePlanArgsSchema = z.object({
  plan: OrchestratorPlanSchema.extend({ tasks: OrchestratorPlanSchema.shape.tasks.min(1) }).strict(),
}).strict();
export type OrchestratorSavePlanArgs = z.infer<typeof OrchestratorSavePlanArgsSchema>;

/** Revises the saved plan in place: patch tasks by id, add tasks, retire tasks with the reason each leaves, or replace the final verification. */
export const OrchestratorUpdateTasksArgsSchema = z.object({
  update: z.array(z.object({
    taskId: z.string().min(1), set: OrchestratorTaskFieldsSchema.omit({ id: true }).partial().strict(),
  }).strict()).default([]),
  add: z.array(OrchestratorTaskSchema).default([]),
  retire: z.array(z.object({ taskId: z.string().min(1), reason: z.string().trim().min(1) }).strict()).default([]),
  finalVerification: OrchestratorPlanSchema.shape.finalVerification.optional(),
}).strict();
export type OrchestratorUpdateTasksArgs = z.infer<typeof OrchestratorUpdateTasksArgsSchema>;

/** Ends the active approach with what it taught, keeps or rolls back its changes, and names the next approach. */
export const OrchestratorChangeApproachArgsSchema = z.object({
  lesson: z.string().trim().min(1), rollback: z.boolean(), title: z.string().trim().min(1),
}).strict();
export type OrchestratorChangeApproachArgs = z.infer<typeof OrchestratorChangeApproachArgsSchema>;

/** Starts one fresh child for one saved task; children run one at a time. */
export const OrchestratorDispatchArgsSchema = z.object({
  taskId: z.string().min(1), purpose: OrchestratorChildPurposeSchema, instruction: z.string().trim().min(1),
}).strict();
export type OrchestratorDispatchArgs = z.infer<typeof OrchestratorDispatchArgsSchema>;

/** The orchestrator's answer to an escalated child approval; `escalate` hands it to the person. */
export const OrchestratorDecideArgsSchema = z.object({
  approvalId: z.string().uuid(), decision: z.enum(['approve', 'deny', 'escalate']), reason: z.string().trim().min(1),
}).strict();
export type OrchestratorDecideArgs = z.infer<typeof OrchestratorDecideArgsSchema>;

export const OrchestratorRunCheckArgsSchema = z.object({ command: z.string().trim().min(1), cwd: z.string().min(1) }).strict();
export type OrchestratorRunCheckArgs = z.infer<typeof OrchestratorRunCheckArgsSchema>;

export const OrchestratorRecordReviewArgsSchema = z.object({
  taskId: z.string().min(1), verdict: z.enum(['pass', 'fail']),
  criteria: OrchestratorReviewRecordSchema.shape.criteria, findings: z.array(OrchestratorReviewFindingSchema).default([]),
}).strict();
export type OrchestratorRecordReviewArgs = z.infer<typeof OrchestratorRecordReviewArgsSchema>;

/** The orchestrator's final answer; `blocked` ends the run without completing it. */
export const OrchestratorFinishSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), summary: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal('blocked'), reason: z.string().trim().min(1) }).strict(),
]);
export type OrchestratorFinish = z.infer<typeof OrchestratorFinishSchema>;

/** One reserved child to start; its purpose is `work.kind`. */
export const OrchestratorChildRequestSchema = z.object({
  runId: z.string().uuid(), taskId: z.string().min(1), attempt: OrchestratorAttemptNumberSchema,
  childRunId: z.string().uuid(), workerPresetId: z.string().trim().min(1), repoRoot: z.string().min(1),
  work: OrchestratorChildWorkSchema, instruction: z.string().trim().min(1),
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


/** How many of a child's latest tool calls the live view keeps. */
export const ORCHESTRATOR_RECENT_TOOL_LIMIT = 4;
/** How many of the orchestrator's latest turns the live view keeps. */
export const ORCHESTRATOR_RECENT_TURN_LIMIT = 12;
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

/** One orchestrator turn as the board shows it: its thinking, its text, and each tool call with its result. */
export const OrchestratorParentTurnSchema = z.object({
  turn: z.number().int().positive(), thinking: z.string(), text: z.string(),
  tools: z.array(z.object({
    toolCallId: z.string().min(1), command: z.string(), status: z.enum(['running', 'succeeded', 'failed']), output: z.string(),
  }).strict()),
}).strict();
export type OrchestratorParentTurn = z.infer<typeof OrchestratorParentTurnSchema>;

/**
 * The orchestrator's own live conversation; `parked` means it released its model while its child or a check works.
 * `contextTokens` is the context window its prompt fills.
 */
export const OrchestratorParentActivitySchema = z.object({
  waitingForModel: z.boolean(), parked: z.boolean(), promptTokens: z.number().nonnegative(), contextTokens: z.number().positive(),
  prompt: z.object({ system: z.string(), user: z.string() }).strict().nullable(),
  turnCount: z.number().int().nonnegative(),
  turns: z.array(OrchestratorParentTurnSchema).max(ORCHESTRATOR_RECENT_TURN_LIMIT),
}).strict();
export type OrchestratorParentActivity = z.infer<typeof OrchestratorParentActivitySchema>;

/** The model a task's child runs on, and that model's context size. */
export const OrchestratorTaskClaimSchema = z.object({
  taskId: z.string().min(1), modelId: z.string().min(1), contextTokens: z.number().positive(),
}).strict();
export type OrchestratorTaskClaim = z.infer<typeof OrchestratorTaskClaimSchema>;

/** The latest dispatch: every task's claim, and the unmet dependencies of each pending task that has some. */
export const OrchestratorScheduleSchema = z.object({
  claims: z.array(OrchestratorTaskClaimSchema),
  waits: z.array(z.object({ taskId: z.string().min(1), dependencies: z.array(z.string().min(1)).min(1) }).strict()),
}).strict();
export type OrchestratorSchedule = z.infer<typeof OrchestratorScheduleSchema>;

/** The run's live view; the schedule is null until the first dispatch, the parent null until it starts. */
export const OrchestratorActivitySchema = z.object({
  runId: z.string().uuid(), schedule: OrchestratorScheduleSchema.nullable(),
  parent: OrchestratorParentActivitySchema.nullable(), children: z.array(OrchestratorChildActivitySchema),
}).strict();
export type OrchestratorActivity = z.infer<typeof OrchestratorActivitySchema>;
