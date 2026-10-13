import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  type OrchestratorAttemptResult,
  type OrchestratorCheckResult,
  type OrchestratorChildPurpose,
  type OrchestratorCommandCheck,
  type OrchestratorDriftCorrectionWork,
  type OrchestratorDriftFinding,
  type OrchestratorPlan,
  type OrchestratorTask,
  type OrchestratorVerificationCheck,
  type ModelRuntimePreset,
  type RepoAgentApproval,
  type SiftPreset,
} from '@siftkit/contracts';

import type { JsonObject } from '../lib/json-types.ts';
import { RUN_SHELL_LABEL } from '../lib/powershell.ts';
import { renderOrchestratorPlan } from './plan.ts';

const CHECK_OUTPUT_PROMPT_CHARS = 4_000;
const CHECK_SHELL_RULE = `Command checks run in ${RUN_SHELL_LABEL} from their cwd: use PowerShell syntax, cmdlets, and programs on PATH only`
  + ' (grep, sed, awk, bash, and && are unavailable).';

/** How an evidence review answers; shared by task review and final verification. */
export const EVIDENCE_REVIEW_GUIDANCE = 'Answer "pass" with evidence whose snippet is the exact code at each cited line, or "fail" with one finding per problem.';

function formatCheck(check: OrchestratorVerificationCheck): string {
  return check.kind === 'command'
    ? `Run \`${check.command}\` in ${check.cwd}; expected exit ${check.expectedExitCode}.`
    : `${check.instruction} (inspect ${check.paths.join(', ')})`;
}

function formatCheckResult(result: OrchestratorCheckResult): string {
  if (result.check.kind === 'evidence') return `- evidence: ${result.check.instruction}`;
  const status = !result.executed ? 'not executed' : result.timedOut ? 'timed out' : `exit ${result.exitCode ?? 'unknown'}`;
  return [`- \`${result.check.command}\` (${result.check.cwd}): ${status}`,
    '```', result.output.slice(-CHECK_OUTPUT_PROMPT_CHARS), '```'].join('\n');
}

/** A worker preset and the model it runs on in this run's configuration. */
export type PlanWorker = { preset: SiftPreset; model: ModelRuntimePreset };

/** Dirt in the checkout before this work started: a reviewer must never charge it to the work. */
function describePreexistingChanges(subject: 'run' | 'task', paths: readonly string[]): string {
  const scope = subject === 'run' ? 'this run' : 'this task, beyond those listed in the run context';
  return `Uncommitted changes that predate ${scope} (not made by it; never count them against it): ${paths.join(', ') || 'none'}.`;
}

/** The problems that rejected the parent's previous answer, as prompt lines; none on a first try. */
export function describeRejection(subject: 'answer' | 'review' | 'report', problems: readonly string[]): string[] {
  return problems.length === 0 ? [] : [`Your previous ${subject} was rejected:`, ...problems.map((problem) => `- ${problem}`)];
}

function describeWorker({ preset, model }: PlanWorker): string {
  const access = preset.presetKind === 'repo-search' ? 'read-only' : 'can modify files';
  const slots = model.ParallelSlots === 1 ? '1 parallel slot' : `${model.ParallelSlots} parallel slots`;
  return `- ${preset.id} (${preset.presetKind}, ${access}; model ${model.id}, ${slots}): ${preset.description}`;
}

/** What every parent phase of one run shares; rendered first so the phases reuse one KV prefix. */
export type RunContext = {
  task: string | null;
  workers: readonly PlanWorker[];
  preexistingDirtyPaths: readonly string[];
  plan: { path: string; hash: string; plan: OrchestratorPlan } | null;
};

export function buildRunContext(run: RunContext): string {
  return [
    'Orchestrator run context (shared by every phase of this run):',
    `Requested task: ${run.task ?? '(none; execute the supplied plan)'}`,
    'Worker presets (never another orchestrator):', ...run.workers.map(describeWorker),
    CHECK_SHELL_RULE,
    describePreexistingChanges('run', run.preexistingDirtyPaths),
    'The repository file listing in your instructions was taken when this run started; use ls and find for the current state.',
    ...(run.plan === null ? [] : [`Saved plan ${run.plan.path} (sha256 ${run.plan.hash}):`, '<<<PLAN',
      renderOrchestratorPlan(run.plan.plan), 'PLAN>>>']),
  ].join('\n');
}

/** A parent prompt: the shared run block first (one KV prefix for every phase), then the phase, then the answer's JSON schema. */
export function buildParentPrompt(run: RunContext, phasePrompt: string, answerSchema: JsonObject): string {
  return [buildRunContext(run), phasePrompt,
    'Answer with exactly one JSON object that matches this JSON schema:', JSON.stringify(answerSchema)].join('\n');
}

export function buildPlanPreparationPrompt(input: {
  planPath: string | null;
  planMarkdown: string | null;
  rejectedProblems: readonly string[];
}): string {
  return [
    'Phase: prepare the executable plan for this orchestrator run.',
    input.planMarkdown === null
      ? 'Supplied plan: none.'
      : [`Supplied plan (${input.planPath ?? 'inline'}):`, '<<<PLAN', input.planMarkdown, 'PLAN>>>'].join('\n'),
    'Assign each task one of the worker presets listed in the run context.',
    'Inspect the repository to confirm every referenced file and symbol exists. Each task must be one discrete, verifiable',
    'unit with bounded read/write paths, concrete steps, exact verification checks, and acceptance criteria. Read-only',
    'tasks use a read-only worker and evidence checks; tasks that modify files use a worker that can modify files.',
    'Tasks with no dependsOn path between them may run at the same time, up to their worker model\'s parallel slots, with',
    'at most one task that modifies files at a time. A task that needs another task\'s output or changes must list it in',
    'dependsOn. Split the work into parallel tasks only where that suits it.',
    ...describeRejection('answer', input.rejectedProblems),
    'Answer status "ready" when the supplied plan is adequate (its plan must be that plan\'s faithful manifest), "generated" when',
    'there is no plan or the supplied one is inadequate (list what was inadequate in "issues"), or "blocked" with a "reason"',
    'when the request cannot be planned safely (for example an ambiguous target). A command check\'s cwd is relative to the',
    'repository root, usually ".".',
  ].join('\n');
}

export function buildAttemptReviewPrompt(input: {
  task: OrchestratorTask;
  result: Pick<OrchestratorAttemptResult, 'workerOutput' | 'checks' | 'changedPaths'>;
  preexistingDirtyPaths: readonly string[];
  rejectedProblems: readonly string[];
}): string {
  return [
    `Phase: review the evidence for task '${input.task.id}' (${input.task.title}).`,
    'Acceptance criteria:', ...input.task.acceptance.map((entry) => `- ${entry}`),
    'Evidence checks to confirm yourself with repository tools:',
    ...input.task.verification.filter((check) => check.kind === 'evidence').map((check) => `- ${formatCheck(check)}`),
    'Recorded command results:', ...input.result.checks.map(formatCheckResult),
    `Changed paths: ${input.result.changedPaths.join(', ') || '(none)'}`,
    describePreexistingChanges('task', input.preexistingDirtyPaths),
    'Worker report (a claim, not evidence):', input.result.workerOutput,
    'Read the cited files yourself. Pass only when every criterion is supported by repository evidence you checked.',
    EVIDENCE_REVIEW_GUIDANCE,
    ...describeRejection('review', input.rejectedProblems),
  ].join('\n');
}

export function buildDriftReviewPrompt(input: {
  task: OrchestratorTask;
  changeDigest: string;
  diff: string;
  changedPaths: readonly string[];
  openFindings: readonly OrchestratorDriftFinding[];
  checks: readonly OrchestratorCheckResult[];
  rejectedProblems: readonly string[];
}): string {
  return [
    `Phase: critical code-drift review of step '${input.task.id}' (${input.task.title}).`,
    `Change digest: ${input.changeDigest}. Changed paths: ${input.changedPaths.join(', ')}.`,
    'Attributable diff of this step against its starting baseline:', '```diff', input.diff, '```',
    'Verification results:', ...input.checks.map(formatCheckResult),
    ...(input.openFindings.length === 0 ? [] : [
      'Previously confirmed findings; account for every one in "resolutions" or report it again:',
      ...input.openFindings.map((finding) => `- ${finding.id}: ${finding.title} (fix: ${finding.fix})`),
    ]),
    'Read applicable repository instructions (AGENTS.md, CLAUDE.md) and the touched code with its immediate callers.',
    'Accept a finding only when ALL hold:',
    '- This step introduced or worsened it, anchored to current file:line evidence with a short exact snippet.',
    '- It conflicts with an applicable directive or the accepted architecture/requirements.',
    '- It has a concrete correctness, reliability, security, performance, or lasting maintainability consequence.',
    '- A proportionate fix removes the cause and names affected callers/tests; for overengineering, the simpler structure.',
    '- You considered legitimate reasons for the current design and still hold the finding with high confidence.',
    'Look for incomplete refactors, special-case patches, stale shims or parallel paths, duplicated behavior that will',
    'diverge, unjustified hardcoding, unsafe type/IO handling, needless indirection, disproportionate abstractions, and',
    'material test gaps. Do NOT flag formatting, naming preferences, deliberate domain constants, external-API callbacks,',
    'necessary state-owning classes, allowed `as const`/`satisfies`, speculative future generality, or unchanged',
    'pre-existing debt. Zero findings is a valid, desirable answer; there is no quota.',
    'Answer status "clean" with no findings, or "actionable" with your findings; account for every previously confirmed',
    'finding in "resolutions". Never answer "not_required": the host uses it only for steps without code changes.',
    `Use taskId "${input.task.id}" and changeDigest "${input.changeDigest}".`,
    ...describeRejection('report', input.rejectedProblems),
  ].join('\n');
}

export function buildChildApprovalPrompt(input: {
  task: OrchestratorTask;
  purpose: OrchestratorChildPurpose;
  attempt: number;
  approval: RepoAgentApproval;
}): string {
  return [
    `Phase: decide a subagent's permission request. Your subagent working on task '${input.task.id}' (${input.task.title}),`,
    `${input.purpose} attempt ${input.attempt}, is paused waiting for you to approve or deny one action.`,
    `Tool: ${input.approval.toolName}`,
    `Requested action: ${input.approval.command}`,
    ...(input.approval.reviewPayload === null ? [] : ['Proposed content:', input.approval.reviewPayload]),
    `The task may write: ${input.task.writePaths.join(', ') || '(nothing)'}.`,
    'Steps:', ...input.task.steps.map((step) => `- ${step.instruction}`),
    'Approve only when the action is needed for this task, stays within its scope, and cannot damage unrelated work,',
    'history, or the machine. Deny anything destructive, out of scope, or unexplained, and say why.',
  ].join('\n');
}

export function buildCheckApprovalPrompt(input: {
  task: OrchestratorTask | null;
  check: OrchestratorCommandCheck;
}): string {
  return [
    `Phase: decide whether to run one verification command for ${input.task === null
      ? 'the final verification of the whole run' : `task '${input.task.id}' (${input.task.title})`}.`,
    `Command: ${input.check.command}`,
    `Working directory: ${input.check.cwd}`,
    'The plan declared this check, but it runs as a real shell command in the repository.',
    'Approve only a command that verifies the work without changing tracked files, history, or the machine.',
    'Deny anything destructive, networked without need, or unrelated to verification, and say why.',
  ].join('\n');
}

export function buildFinalVerificationPrompt(input: {
  checks: readonly OrchestratorCheckResult[];
  rejectedProblems: readonly string[];
}): string {
  return [
    'Phase: final verification of the whole run.',
    'Recorded final command results:', ...input.checks.map(formatCheckResult),
    'Confirm each evidence check yourself with repository tools.',
    ...describeRejection('review', input.rejectedProblems),
    EVIDENCE_REVIEW_GUIDANCE,
  ].join('\n');
}

/** What attempt 2 must know about attempt 1: the observed failure and the work to keep. */
export type ImplementationRetryEvidence = {
  failure: string;
  checks: readonly OrchestratorCheckResult[];
  changedPaths: readonly string[];
  diff: string;
};

export function buildImplementationInstruction(input: {
  task: OrchestratorTask;
  planPath: string;
  planHash: string;
  attempt: number;
  scratchPath: string;
  preexistingDirtyPaths: readonly string[];
  retry: ImplementationRetryEvidence | null;
}): string {
  const { task } = input;
  return [
    `Implement ONLY task '${task.id}' — ${task.title} — from plan ${input.planPath} (hash ${input.planHash}).`,
    `This is implementation attempt ${input.attempt} of ${ORCHESTRATOR_MAX_ATTEMPTS}.`,
    `Read: ${task.readPaths.join(', ') || '(as needed)'}`,
    `Allowed to modify: ${task.writePaths.join(', ') || '(nothing; this task is read-only)'}`,
    `Scratch directory for temporary files: ${input.scratchPath}`,
    'Steps:', ...task.steps.map((step, index) => `${index + 1}. ${step.instruction} Expected: ${step.expectedResult}`),
    'Verification you must run and pass:', ...task.verification.map((check) => `- ${formatCheck(check)}`),
    'Acceptance:', ...task.acceptance.map((entry) => `- ${entry}`),
    ...(input.preexistingDirtyPaths.length === 0 ? [] : [
      `These files already had uncommitted changes before you started; preserve them: ${input.preexistingDirtyPaths.join(', ')}`,
    ]),
    ...(input.retry === null ? [] : [
      'The previous attempt failed. Keep its successful work and fix exactly this:', input.retry.failure,
      'Observed check results:', ...input.retry.checks.map(formatCheckResult),
      `Files it changed: ${input.retry.changedPaths.join(', ') || '(none)'}`,
      'Its diff:', '```diff', input.retry.diff, '```',
    ]),
    'Use TDD where behavior changes. Do not commit, do not create a plan, and do not work on any other task.',
    'Put temporary files only in the scratch directory. Report changed files and verification results.',
  ].join('\n');
}

export function buildDriftCorrectionPrompt(work: OrchestratorDriftCorrectionWork, retryEvidence: string | null): string {
  const bullets = work.findings.flatMap((finding) => [
    `- ${finding.id}: ${finding.title}`,
    `  Evidence: ${finding.evidence.map((item) => `${item.path}:${item.line} ${item.snippet}`).join('; ')}`,
    `  Directive: ${finding.directive}`,
    `  Purpose: ${finding.purpose}`,
    `  Impact: ${finding.impact}`,
    `  Fix: ${finding.fix}`,
  ]);
  return [
    `Resolve only the confirmed drift in step ${work.taskId}. Objective: ${work.objective}`,
    ...bullets,
    `Allowed files: ${work.allowedPaths.join(', ')}`,
    'Verify the corrections and preserve the original task acceptance:', ...work.verification.map((check) => `- ${formatCheck(check)}`),
    ...(retryEvidence === null ? [] : ['The previous correction did not resolve the drift:', retryEvidence]),
    'Preserve successful work and unrelated edits. Do not create a new plan or commit.',
    'Reproduce behavioral defects with a failing regression test before fixing them.',
    'Use existing behavior checks for structural-only changes; avoid tests that mirror implementation.',
    'Report changed files, verification results, and unresolved findings.',
  ].join('\n');
}
