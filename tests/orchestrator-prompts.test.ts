import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorHandoffReportSchema, type ApprovalMode, type OrchestratorChildWork } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { HANDOFF_REPORT_MAX_CHARS } from '../src/orchestrator/handoff.ts';
import { buildChildInstruction, buildOrchestratorPrompt, type OrchestratorBrief } from '../src/orchestrator/prompts.ts';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { UNFILTERED_CHECK_OUTPUT_RULE } from '../src/output-digest/types.ts';

const config = getDefaultConfigObject();
const model = config.Server.ModelPresets.Presets[0];
const worker = config.Presets.find((preset) => preset.id === 'repo-agent');
const task = makeOrchestratorTask({ id: 'greeting', title: 'Add greeting', writePaths: ['src/greeting.ts'],
  acceptance: ['greet() returns a greeting.', 'A test covers it.'] });

function brief(overrides: Partial<OrchestratorBrief> = {}): OrchestratorBrief {
  assert.ok(model && worker);
  return { task: 'Add a greeting module.', suppliedPlan: null, workers: [{ preset: worker, model }],
    repoRoot: 'C:/work/repo', preexistingDirtyPaths: ['README.md'], approval: 'auto', budget: { minutes: 90, dispatches: 12 }, ...overrides };
}

function work(kind: OrchestratorChildWork['kind']): OrchestratorChildWork {
  return { kind, planPath: '.siftkit/orchestrator/r/plan.md', planHash: 'a'.repeat(64), task, instruction: 'Export greet() from src/greeting.ts.' };
}

/** The JSON object after the last line that introduces the report template. */
function reportTemplate(instruction: string): string {
  const template = instruction.split('\n').at(-1);
  assert.ok(template !== undefined);
  return template;
}

test('the orchestrator prompt states the task, the workers, the run baseline, and the whole process once', () => {
  const prompt = buildOrchestratorPrompt(brief());
  assert.ok(model && worker);
  assert.match(prompt, /Requested task: Add a greeting module\./u);
  assert.match(prompt, /Supplied plan: none\./u);
  assert.ok(prompt.includes(`- repo-agent (model ${model.id}, ${model.NumCtx} context tokens): `), prompt);
  assert.match(prompt, /Command checks run in PowerShell/u);
  assert.match(prompt, /Uncommitted changes that predate this run \(never count them against any task\): README\.md\./u);
  for (const tool of ['save_plan', 'update_tasks', 'dispatch', 'record_review', 'run_check', 'change_approach']) assert.ok(prompt.includes(tool), tool);
  assert.match(prompt, /\{"status":"completed","summary":"what was done"\}/u);
  assert.match(prompt, /\{"status":"blocked","reason":"why"\}/u);
});

test('the orchestrator prompt states the budget and tells the model to keep going by replacing tasks and changing approach', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of [
    'Budget: this run may start 12 children and run 90 minutes',
    'Keep going until the goal is met',
    'retire: [{taskId, reason}]',
    'call change_approach',
    'Never repeat a task or an approach that a lesson already ruled out',
    'a child must run before you finish again',
    'only when no approach can meet the goal',
  ]) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.doesNotMatch(prompt, /If the work cannot be\s+completed, finish/u, 'a failed approach is no longer a reason to stop');
});

test('the orchestrator prompt names the repository root and forbids naming any other repository path', () => {
  assert.ok(buildOrchestratorPrompt(brief()).includes('Repository root: C:/work/repo. You, run_check, and every child already work there: '
    + 'write repository-relative paths in instructions and never name another repository path.'));
});

test('the orchestrator reviews with verbatim one-line snippets or passed commands, and a pass carries no notes', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['the snippet one line copied\n   exactly as read shows it, with no comment, "...", or paraphrase',
    'a command that passed ({command}: a check of the\n   attempt, or your run_check since the report)', 'A pass carries no findings; leave out notes that need no fix.']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('the orchestrator prompt carries the planning rules that keep tasks small and fully verified', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['about 6 write paths, never more than 8', 'Steps are test-first', 'every test suite its change can affect',
    'plus the project\'s typecheck and lint commands', 'finalVerification always includes the project\'s typecheck and lint commands', 'dependsOn names every task']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('the orchestrator explores the code and runs checks itself, and plans only implementation tasks', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['Explore the code yourself with read, grep, find, ls, and git', 'Use run_check',
    'baseline', 'reproduce', 'never to change files', 'add the rest with update_tasks', 'Review every reported task',
    'writePaths are guidance, not a limit', 'line counts, not the code', 'Dispatch one task at a time']) {
    assert.ok(prompt.includes(rule), rule);
  }
  for (const gone of ['survey', 'Survey', 'read-only', 'Leave code exploration to subagents', 'never to read files or search code']) {
    assert.equal(prompt.includes(gone), false, gone);
  }
});

test('the orchestrator sizes files with find and ls and runs checks without tail pipelines', () => {
  const prompt = buildOrchestratorPrompt(brief());
  assert.ok(prompt.includes('find and ls report each file\'s line count; use them to size files, not run_check.'));
  assert.equal(prompt.includes(UNFILTERED_CHECK_OUTPUT_RULE), false, 'the unfiltered-output rule is stated once, in the run_check tool');
});

test('the orchestrator adds implementation tasks in small batches in dependency order', () => {
  const prompt = buildOrchestratorPrompt(brief());
  assert.ok(prompt.includes('adding at most 4 new tasks per save_plan or update_tasks call'), prompt);
  // Real case (run e85529c8): a retire-2, add-3, rewire-4 restructure took six calls, five refused.
  // The prompt wraps its lines; the rule is read as one sentence.
  assert.ok(prompt.replace(/\n\s+/gu, ' ').includes('A restructure is one update_tasks call: add the replacements, repoint the dependents\' dependsOn,'
    + ' and retire the old tasks together; retirements and changes to existing tasks do not count toward the 4.'), prompt);
});

test('the review step judges every deviation and host finding, and treats a weakened or silenced test as a defect', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['a weakened or silenced test', 'Judge every deviation and host finding against that list',
    'a change to a test outside the task', 'is a finding unless the plan asked for it']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('a supplied plan is quoted whole, and the task line says to execute it when no task was given', () => {
  const prompt = buildOrchestratorPrompt(brief({ task: null, suppliedPlan: { path: 'docs/plan.md', markdown: '# Plan\n## Task a' } }));
  assert.match(prompt, /Requested task: \(none; execute the supplied plan\)/u);
  assert.ok(prompt.includes('Supplied plan (docs/plan.md):\n<<<PLAN\n# Plan\n## Task a\nPLAN>>>'), prompt);
});

test('each approval mode tells the orchestrator who answers escalations', () => {
  const rule = (approval: ApprovalMode) => buildOrchestratorPrompt(brief({ approval })).split('\n').at(-1);
  assert.match(rule('off') ?? '', /approved without asking you/u);
  assert.match(rule('auto') ?? '', /call decide/u);
  assert.match(rule('interactive') ?? '', /the user answers every escalated child action and every check command/u);
});

test('a child instruction names its task, the orchestrator instruction, scope, steps, checks, and criteria by index', () => {
  const instruction = buildChildInstruction({ work: work('implementation'), attempt: 1, repoRoot: 'C:/work/repo',
    scratchPath: 'C:/scratch', preexistingDirtyPaths: ['README.md'] });
  assert.ok(instruction.includes('Repository root: C:/work/repo. Your tools and shell already run there; keep every command and path inside it.'), instruction);
  assert.ok(instruction.startsWith("Implement ONLY task 'greeting' — Add greeting — from plan .siftkit/orchestrator/r/plan.md"), instruction);
  assert.match(instruction, /implementation attempt 1 of 2\./u);
  assert.ok(instruction.includes('Instruction from the orchestrator:\nExport greet() from src/greeting.ts.'));
  assert.match(instruction, /Expected to change: src\/greeting\.ts/u);
  assert.match(instruction, /Scratch directory for temporary files: C:\/scratch/u);
  assert.ok(instruction.includes('Acceptance criteria (by index):\n0. greet() returns a greeting.\n1. A test covers it.'));
  assert.match(instruction, /already had uncommitted changes before you started; preserve them: README\.md/u);
  assert.match(instruction, /you may resubmit 2 times/u);
  assert.ok(instruction.includes(`under ${HANDOFF_REPORT_MAX_CHARS} characters`));
});

test('a fix instruction says fix, and a clean tree mentions no prior changes', () => {
  const instruction = buildChildInstruction({ work: work('fix'), attempt: 2, repoRoot: 'C:/work/repo', scratchPath: 'C:/scratch', preexistingDirtyPaths: [] });
  assert.ok(instruction.startsWith("Fix ONLY task 'greeting'"), instruction);
  assert.match(instruction, /fix attempt 2 of 2\./u);
  assert.doesNotMatch(instruction, /already had uncommitted changes/u);
});

test('each child ends with the report template, which names the report schema fields', () => {
  const instruction = buildChildInstruction({ work: work('implementation'), attempt: 1, repoRoot: 'C:/work/repo', scratchPath: 's', preexistingDirtyPaths: [] });
  assert.match(instruction, /Use TDD where behavior changes\./u);
  assert.deepEqual(Object.keys(JsonObjectSchema.parse(parseJsonValueText(reportTemplate(instruction)))),
    Object.keys(OrchestratorHandoffReportSchema.shape));
});

// Real case (run e85529c8): a 38-turn review invented a commit hash, diffed against HEAD~2, and re-checked finished tasks.
test('the review step reviews only the reported task, from its uncommitted diff against HEAD', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['Review every reported task with record_review, and only that task',
    'completed tasks were already reviewed', 'This run makes no commits',
    'start from the git tool\'s diff (operation diff, path) of each changed path, which compares with HEAD',
    'There are no task commits to look up', 'Use run_check only for tests and commands the review needs, never to read or search']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

// Real case (run e85529c8): each fix ran the full suites 9-14 times before the gate ran them again.
test('a child runs only the tests for what it changes and leaves the full checks to the gate', () => {
  const instruction = buildChildInstruction({ work: work('fix'), attempt: 1, repoRoot: 'C:/work/repo', scratchPath: 's', preexistingDirtyPaths: [] });
  assert.ok(instruction.includes('While you work, run only the test files for the code you change, and the typecheck once before you finish;'
    + ' do not run the full suites or lint yourself: code runs every check above when you finish and returns failures to you.'), instruction);
});

// Real case (run e85529c8): one call per turn for 50 turns, the spec opened at turn 30, and "— actually" left in an instruction.
test('the orchestrator reads the named spec whole first, batches independent reads, and writes instructions as final decisions', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['Read the requirements first, before any other exploration: the task, then every spec or plan it names,',
    'each read whole from start to end', 'Issue independent reads, greps, and finds together in one turn',
    'Write each instruction as final decisions, each step stated once']) {
    assert.ok(prompt.includes(rule), rule);
  }
});
