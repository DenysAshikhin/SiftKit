import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  ORCHESTRATOR_MAX_FINISH_ATTEMPTS,
  ORCHESTRATOR_MAX_RESUBMITS,
  type ApprovalMode,
  type OrchestratorChildWork,
  type OrchestratorVerificationCheck,
} from '@siftkit/contracts';

import { RUN_SHELL_LABEL } from '../lib/powershell.ts';
import { renderReportInstruction } from './handoff.ts';
import type { PlanWorker } from './scheduler.ts';

const CHECK_SHELL_RULE = `Command checks run in ${RUN_SHELL_LABEL} from their cwd: use PowerShell syntax, cmdlets, and programs on PATH only`
  + ' (grep, sed, awk, bash, and && are unavailable). A cwd is relative to the repository root, usually ".".';

function formatCheck(check: OrchestratorVerificationCheck): string {
  return check.kind === 'command'
    ? `Run \`${check.command}\` in ${check.cwd}; expected exit ${check.expectedExitCode}.`
    : `${check.instruction} (inspect ${check.paths.join(', ')})`;
}

function describeWorker({ preset, model }: PlanWorker): string {
  return `- ${preset.id} (model ${model.id}, ${model.NumCtx} context tokens): ${preset.description}`;
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
    'You run this orchestrator job from start to finish in this one conversation. You read the code, plan, verify, and review;',
    'repo-agent subagents make every change. Everything you learn stays with you across tasks: use it in later instructions.',
    `Requested task: ${brief.task ?? '(none; execute the supplied plan)'}`,
    ...(brief.suppliedPlan === null ? ['Supplied plan: none.']
      : [`Supplied plan (${brief.suppliedPlan.path}):`, '<<<PLAN', brief.suppliedPlan.markdown, 'PLAN>>>']),
    'Worker presets (never another orchestrator):', ...brief.workers.map(describeWorker),
    CHECK_SHELL_RULE,
    `Uncommitted changes that predate this run (never count them against any task): ${brief.preexistingDirtyPaths.join(', ') || 'none'}.`,
    'The repository file listing in your instructions was taken when this run started; use ls and find for the current state.',
    '',
    'How to work:',
    '1. Read the requirements: the task and any spec or plan it names. Explore the code yourself with read, grep, find, ls, and git',
    '   until you can name every file each change touches and the tests that cover it. Read narrowly: grep for symbols and read',
    '   line ranges, not whole directories; your context also has to hold every review.',
    '   Use run_check to establish a baseline of the test suites the work will touch, and to reproduce a reported bug, before',
    '   planning; a suite that already fails is a fact for the plan, not a task\'s fault.',
    '2. Call save_plan with the implementation tasks in dependency order, at most 4 tasks per save_plan or update_tasks call,',
    '   and add the rest with update_tasks, so a malformed call costs little to resend. Planning rules:',
    '   - One task is one concern a worker finishes within about half its context: a handful of files (at most about 6 write',
    '     paths) and their tests. Split anything larger.',
    '   - Every task changes files and lists the paths it expects to change in writePaths, tests included.',
    '   - Steps are test-first: write the failing test, then the implementation.',
    '   - A task\'s verification has command checks for every test suite its change can affect, not only its new tests,',
    '     plus the project\'s typecheck and lint commands, using the exact commands the request names, flags included.',
    '   - finalVerification always includes the project\'s typecheck and lint commands and every relevant test suite.',
    '   - dependsOn names every task whose output or changes a task needs.',
    '3. Dispatch one task at a time, with its dependencies complete. Every child starts fresh and knows only its instruction:',
    '   include what it must change, the files and lines you found, what earlier tasks changed that matters to it, and the',
    `   pitfalls you already know. dispatch waits until the child reports. Code runs a child's checks each time it finishes;`,
    `   it fixes its own failures up to ${ORCHESTRATOR_MAX_RESUBMITS} times before its report reaches you.`,
    '4. Review every reported task with record_review. A report gives the child\'s status, where it departed from the plan,',
    '   the gate\'s last check results, and what changed as line counts, not the code: read the changed code yourself, and use',
    '   run_check for any test or command the review needs.',
    '   Judge each acceptance criterion by index with exact code evidence (path, line, and the code at that line). Record a',
    '   finding for every real defect: a missed requirement, an incomplete refactor, a special-case patch, a leftover shim or',
    '   parallel path, duplicated logic, unsafe type or IO handling, a missing test, a weakened or silenced test.',
    '   Judge every deviation and host finding against that list: a change to a test outside the task (an allowlist or',
    '   skip entry, a loosened assertion, an environment patch) is a finding unless the plan asked for it. Ignore style',
    '   preferences. A task whose checks failed cannot pass.',
    `5. After a failed review, dispatch a fix (repairs the current changes) or a fresh implementation; each task allows ${ORCHESTRATOR_MAX_ATTEMPTS}`,
    '   of each. A completed task can also take a fix later. To split, reorder, add, or widen work, call update_tasks with',
    '   only the fields that change; tasks that already ran keep their ids. writePaths are guidance, not a limit: judge',
    '   changes to other files on their merits, and move work the plan gives a later task with update_tasks.',
    '6. When every task is complete, finish with only {"status":"completed","summary":"what was done"}. Code then runs the',
    `   final verification and returns failures for you to fix (at most ${ORCHESTRATOR_MAX_FINISH_ATTEMPTS} finishes). If the work cannot be`,
    '   completed, finish with only {"status":"blocked","reason":"why"}.',
    'Use run_check to run tests, typecheck, lint, or a command that reproduces a problem; never to change files, install',
    'packages, or commit: that is a child\'s work. Read and search code with your read tools, not run_check.',
    APPROVAL_RULES[brief.approval],
  ].join('\n');
}

/** One fresh child's whole assignment: the plan task, the orchestrator's instruction, the checks, and the report it ends with. */
export function buildChildInstruction(input: {
  work: OrchestratorChildWork;
  attempt: number;
  scratchPath: string;
  preexistingDirtyPaths: readonly string[];
}): string {
  const { task } = input.work;
  return [
    `${input.work.kind === 'fix' ? 'Fix' : 'Implement'} ONLY task '${task.id}' — ${task.title} — from plan ${input.work.planPath}`
      + ` (hash ${input.work.planHash}); ${input.work.kind} attempt ${input.attempt} of ${ORCHESTRATOR_MAX_ATTEMPTS}.`,
    'Instruction from the orchestrator:', input.work.instruction,
    `Read: ${task.readPaths.join(', ') || '(as needed)'}`,
    `Expected to change: ${task.writePaths.join(', ')}`,
    `Scratch directory for temporary files: ${input.scratchPath}`,
    'Steps (by index):', ...task.steps.map((step, index) => `${index}. ${step.instruction} Expected: ${step.expectedResult}`),
    'Checks (code runs every command check when you finish; they must pass):', ...task.verification.map((check) => `- ${formatCheck(check)}`),
    'Acceptance criteria (by index):', ...task.acceptance.map((entry, index) => `${index}. ${entry}`),
    ...(input.preexistingDirtyPaths.length === 0 ? [] : [
      `These files already had uncommitted changes before you started; preserve them: ${input.preexistingDirtyPaths.join(', ')}`,
    ]),
    'Use TDD where behavior changes. Do not commit, do not create a plan, and do not work on any other task.',
    `When you finish, failing checks come back to you here; you may resubmit ${ORCHESTRATOR_MAX_RESUBMITS} times.`,
    renderReportInstruction(),
  ].join('\n');
}
