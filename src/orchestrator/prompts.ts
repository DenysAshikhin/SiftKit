import type {
  OrchestratorAttemptResult,
  OrchestratorCheckResult,
  OrchestratorChildPurpose,
  OrchestratorDriftCorrectionWork,
  OrchestratorDriftFinding,
  OrchestratorTask,
  OrchestratorVerificationCheck,
  RepoAgentApproval,
  SiftPreset,
} from '@siftkit/contracts';

const CHECK_OUTPUT_PROMPT_CHARS = 4_000;

const PLAN_JSON_SHAPE = [
  'Plan JSON shape (every field required):',
  '{"goal": string, "constraints": string[], "tasks": [{"id": "kebab-case", "title": string, "dependsOn": string[],',
  ' "workerPresetId": string, "readPaths": string[], "writePaths": string[],',
  ' "steps": [{"instruction": string, "expectedResult": string}],',
  ' "verification": [{"kind": "command", "command": string, "cwd": ".", "expectedExitCode": 0}',
  '   | {"kind": "evidence", "instruction": string, "paths": string[]}],',
  ' "acceptance": string[], "temporaryPaths": string[]}],',
  ' "finalVerification": [<verification check>, ...]}',
].join('\n');

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

function describeWorker(preset: SiftPreset): string {
  const access = preset.presetKind === 'repo-search' ? 'read-only' : 'can modify files';
  return `- ${preset.id} (${preset.presetKind}, ${access}): ${preset.description}`;
}

export function buildPlanPreparationPrompt(input: {
  task: string | null;
  planPath: string | null;
  planMarkdown: string | null;
  workers: readonly SiftPreset[];
  previousErrors: readonly string[];
}): string {
  return [
    'Phase: prepare the executable plan for this orchestrator run.',
    `Requested task: ${input.task ?? '(none; execute the supplied plan)'}`,
    input.planMarkdown === null
      ? 'Supplied plan: none.'
      : [`Supplied plan (${input.planPath ?? 'inline'}):`, '<<<PLAN', input.planMarkdown, 'PLAN>>>'].join('\n'),
    'Worker presets you may assign (never another orchestrator):',
    ...input.workers.map(describeWorker),
    'Inspect the repository to confirm every referenced file and symbol exists. Each task must be one discrete, verifiable',
    'unit with bounded read/write paths, concrete steps, exact verification checks, and acceptance criteria. Read-only',
    'tasks use a read-only worker and evidence checks; tasks that modify files use a worker that can modify files.',
    ...(input.previousErrors.length === 0 ? [] : ['Your previous answer was rejected:', ...input.previousErrors.map((error) => `- ${error}`)]),
    'Answer with exactly one JSON object:',
    '- {"status": "ready", "plan": <plan>} when the supplied plan is adequate; the plan must be its faithful manifest.',
    '- {"status": "generated", "plan": <plan>, "issues": [string]} when there is no plan or the supplied one is inadequate;',
    '  list what was inadequate in "issues".',
    '- {"status": "blocked", "reason": string} when the request cannot be planned safely (for example an ambiguous target).',
    PLAN_JSON_SHAPE,
  ].join('\n');
}

export function buildAttemptReviewPrompt(input: {
  task: OrchestratorTask;
  result: Pick<OrchestratorAttemptResult, 'workerOutput' | 'checks' | 'changedPaths'>;
}): string {
  return [
    `Phase: review the evidence for task '${input.task.id}' (${input.task.title}).`,
    'Acceptance criteria:', ...input.task.acceptance.map((entry) => `- ${entry}`),
    'Evidence checks to confirm yourself with repository tools:',
    ...input.task.verification.filter((check) => check.kind === 'evidence').map((check) => `- ${formatCheck(check)}`),
    'Recorded command results:', ...input.result.checks.map(formatCheckResult),
    `Changed paths: ${input.result.changedPaths.join(', ') || '(none)'}`,
    'Worker report (a claim, not evidence):', input.result.workerOutput,
    'Read the cited files yourself. Pass only when every criterion is supported by repository evidence you checked.',
    'Answer with exactly one JSON object:',
    '- {"status": "pass", "evidence": ["path:line - what it proves", ...]}',
    '- {"status": "fail", "findings": [{"path": string, "line": number, "issue": string}]}',
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
    'Answer with exactly one JSON object with fields taskId, changeDigest, scopePaths, resolutions',
    '([{"findingId", "evidence"}]) and either:',
    '- "status": "clean", "findings": []',
    '- "status": "actionable", "findings": [{"id": "D1", "title", "purpose", "directive", "evidence": [{"path",',
    '  "line", "snippet"}], "impact", "fix", "affectedPaths": [string], "verification": [<verification check>]}]',
    `Use taskId "${input.task.id}" and changeDigest "${input.changeDigest}".`,
    ...(input.rejectedProblems.length === 0 ? [] : ['Your previous report was rejected:', ...input.rejectedProblems.map((problem) => `- ${problem}`)]),
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
    'Answer with exactly one JSON object: {"decision": "approve" | "deny", "reason": string}.',
  ].join('\n');
}

export function buildFinalVerificationPrompt(input: {
  goal: string;
  checks: readonly OrchestratorCheckResult[];
}): string {
  return [
    `Phase: final verification of the whole run. Goal: ${input.goal}`,
    'Recorded final command results:', ...input.checks.map(formatCheckResult),
    'Confirm each evidence check yourself with repository tools.',
    'Answer with exactly one JSON object:',
    '- {"status": "pass", "evidence": ["path:line - what it proves", ...]}',
    '- {"status": "fail", "findings": [{"path": string, "line": number, "issue": string}]}',
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
    `This is implementation attempt ${input.attempt} of 2.`,
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
