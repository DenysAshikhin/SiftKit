import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  ORCHESTRATOR_MAX_FINISH_ATTEMPTS,
  ORCHESTRATOR_MAX_RESUBMITS,
  type ApprovalMode,
  type ModelRuntimePreset,
  type OrchestratorChildWork,
  type OrchestratorVerificationCheck,
  type SiftPreset,
} from '@siftkit/contracts';

import { RUN_SHELL_LABEL } from '../lib/powershell.ts';
import { renderReportInstruction, type HandoffKind } from './handoff.ts';

const CHECK_SHELL_RULE = `Command checks run in ${RUN_SHELL_LABEL} from their cwd: use PowerShell syntax, cmdlets, and programs on PATH only`
  + ' (grep, sed, awk, bash, and && are unavailable). A cwd is relative to the repository root, usually ".".';

function formatCheck(check: OrchestratorVerificationCheck): string {
  return check.kind === 'command'
    ? `Run \`${check.command}\` in ${check.cwd}; expected exit ${check.expectedExitCode}.`
    : `${check.instruction} (inspect ${check.paths.join(', ')})`;
}

/** A worker preset and the model it runs on in this run's configuration. */
export type PlanWorker = { preset: SiftPreset; model: ModelRuntimePreset };

function describeWorker({ preset, model }: PlanWorker): string {
  const access = preset.presetKind === 'repo-search' ? 'read-only' : 'can modify files';
  const slots = model.ParallelSlots === 1 ? '1 parallel slot' : `${model.ParallelSlots} parallel slots`;
  return `- ${preset.id} (${preset.presetKind}, ${access}; model ${model.id}, ${model.NumCtx} context tokens, ${slots}): ${preset.description}`;
}

const APPROVAL_RULES: Record<ApprovalMode, string> = {
  off: 'Approvals: off. Children review their own risky actions; anything they escalate is approved without asking you.',
  auto: 'Approvals: when dispatch or decide returns a child\'s approval request, call decide. Approve actions the task needs within'
    + ' its scope; deny destructive, out-of-scope, or unexplained ones; escalate to the user only what you cannot judge.',
  interactive: 'Approvals: the user answers every escalated child action and every check command; you are never asked.',
};

/** What the orchestrator is told once, at the start of its one conversation. */
export type OrchestratorBrief = {
  task: string | null;
  suppliedPlan: { path: string; markdown: string } | null;
  workers: readonly PlanWorker[];
  preexistingDirtyPaths: readonly string[];
  approval: ApprovalMode;
};

export function buildOrchestratorPrompt(brief: OrchestratorBrief): string {
  return [
    'You run this orchestrator job from start to finish in this one conversation. Subagents do the work; you plan,',
    'dispatch, review, and decide. Everything you learn stays with you across tasks: use it in later instructions.',
    `Requested task: ${brief.task ?? '(none; execute the supplied plan)'}`,
    ...(brief.suppliedPlan === null ? ['Supplied plan: none.']
      : [`Supplied plan (${brief.suppliedPlan.path}):`, '<<<PLAN', brief.suppliedPlan.markdown, 'PLAN>>>']),
    'Worker presets (never another orchestrator):', ...brief.workers.map(describeWorker),
    CHECK_SHELL_RULE,
    `Uncommitted changes that predate this run (never count them against any task): ${brief.preexistingDirtyPaths.join(', ') || 'none'}.`,
    'The repository file listing in your instructions was taken when this run started; use ls and find for the current state.',
    '',
    'How to work:',
    '1. Read the requirements: the task and any spec or plan it names. Leave code exploration to subagents; read code',
    '   yourself only to confirm a specific file, line, or symbol.',
    '2. Survey first. Call save_plan with at most 2 survey tasks, only for what the requirements do not already locate. Each',
    '   asks one narrow question about the code (where a feature lives, who calls it, which tests cover it) whose answer',
    '   fits in one report: a dozen cited findings, not an inventory. Give each a read-only worker, readPaths as its',
    '   starting point, one evidence check, and acceptance stating what the answer must cite; include the',
    '   finalVerification. Dispatch them together. A survey is not reviewed: it completes when its checks pass, and one',
    '   that fails returns to pending for another attempt or removal with update_tasks.',
    '3. From what the surveys found, decide the next step yourself. Survey again only for something the implementation still',
    '   cannot locate (at most 4 surveys in total); otherwise add the implementation tasks with update_tasks. Planning rules:',
    '   - One task is one concern a worker finishes within about half its context: a handful of files (at most about 6 write',
    '     paths) and their tests. Split anything larger.',
    '   - A task that changes files uses a worker that can modify files, and lists the paths it expects to change in',
    '     writePaths, tests included. A read-only task uses a read-only worker.',
    '   - Steps are test-first: write the failing test, then the implementation.',
    '   - A task\'s verification has command checks for every test suite its change can affect, not only its new tests,',
    '     plus the project\'s typecheck and lint commands, using the exact commands the request names, flags included.',
    '   - finalVerification always includes the project\'s typecheck and lint commands and every relevant test suite.',
    '   - dependsOn names every task whose output or changes a task needs.',
    '4. Call dispatch with at most one task that changes files and one read-only task, each with its dependencies complete.',
    '   Every child starts fresh and knows only its instruction: include what it must change, what earlier tasks found or',
    '   changed that matters to it, and the pitfalls you already know. dispatch waits until the children report.',
    `   Code runs a child's checks each time it finishes; it fixes its own failures up to ${ORCHESTRATOR_MAX_RESUBMITS} times before`,
    '   its report reaches you.',
    '5. Review every reported task that changes files with record_review. A report gives the child\'s status, where it',
    '   departed from the plan, the gate\'s last check results, and what changed as line counts, not the code: read the',
    '   changed code yourself.',
    '   Judge each acceptance criterion by index with exact code evidence (path, line, and the code at that line). Record a',
    '   finding for every real defect: a missed requirement, an incomplete refactor, a special-case patch, a leftover shim or',
    '   parallel path, duplicated logic, unsafe type or IO handling, a missing test. Ignore style preferences. A task whose',
    '   checks failed cannot pass.',
    `6. After a failed review, dispatch a fix (repairs the current changes) or a fresh implementation; each task allows ${ORCHESTRATOR_MAX_ATTEMPTS}`,
    '   of each. A completed task can also take a fix later. To split, reorder, add, or widen work, call update_tasks with',
    '   only the fields that change; tasks that already ran keep their ids. writePaths are guidance, not a limit: judge',
    '   changes to other files on their merits, and move work the plan gives a later task with update_tasks.',
    '7. When every task is complete, finish with only {"status":"completed","summary":"what was done"}. Code then runs the',
    `   final verification and returns failures for you to fix (at most ${ORCHESTRATOR_MAX_FINISH_ATTEMPTS} finishes). If the work cannot be`,
    '   completed, finish with only {"status":"blocked","reason":"why"}.',
    'Use run_check only to run a verification command a review needs, never to read files or search code.',
    APPROVAL_RULES[brief.approval],
  ].join('\n');
}

/** One fresh child's whole assignment: the plan task, the orchestrator's instruction, the checks, and the report it ends with. */
export function buildChildInstruction(input: {
  work: OrchestratorChildWork;
  attempt: number;
  kind: HandoffKind;
  scratchPath: string;
  preexistingDirtyPaths: readonly string[];
}): string {
  const { task } = input.work;
  return [
    `${input.work.kind === 'fix' ? 'Fix' : 'Implement'} ONLY task '${task.id}' — ${task.title} — from plan ${input.work.planPath}`
      + ` (hash ${input.work.planHash}); ${input.work.kind} attempt ${input.attempt} of ${ORCHESTRATOR_MAX_ATTEMPTS}.`,
    'Instruction from the orchestrator:', input.work.instruction,
    `Read: ${task.readPaths.join(', ') || '(as needed)'}`,
    `Expected to change: ${task.writePaths.join(', ') || '(nothing; this task is read-only)'}`,
    `Scratch directory for temporary files: ${input.scratchPath}`,
    'Steps (by index):', ...task.steps.map((step, index) => `${index}. ${step.instruction} Expected: ${step.expectedResult}`),
    'Checks (code runs every command check when you finish; they must pass):', ...task.verification.map((check) => `- ${formatCheck(check)}`),
    'Acceptance criteria (by index):', ...task.acceptance.map((entry, index) => `${index}. ${entry}`),
    ...(input.preexistingDirtyPaths.length === 0 ? [] : [
      `These files already had uncommitted changes before you started; preserve them: ${input.preexistingDirtyPaths.join(', ')}`,
    ]),
    input.kind === 'agent'
      ? 'Use TDD where behavior changes. Do not commit, do not create a plan, and do not work on any other task.'
      : 'Answer from the repository only. Do not change files.',
    `When you finish, failing checks come back to you here; you may resubmit ${ORCHESTRATOR_MAX_RESUBMITS} times.`,
    renderReportInstruction(input.kind),
  ].join('\n');
}
