import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorHandoffReportSchema, type ApprovalMode, type OrchestratorChildWork } from '@siftkit/contracts';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { HANDOFF_REPORT_MAX_CHARS } from '../src/orchestrator/handoff.ts';
import { buildChildInstruction, buildOrchestratorPrompt, type OrchestratorBrief } from '../src/orchestrator/prompts.ts';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const config = getDefaultConfigObject();
const model = config.Server.ModelPresets.Presets[0];
const worker = config.Presets.find((preset) => preset.id === 'repo-agent');
const task = makeOrchestratorTask({ id: 'greeting', title: 'Add greeting', writePaths: ['src/greeting.ts'],
  acceptance: ['greet() returns a greeting.', 'A test covers it.'] });

function brief(overrides: Partial<OrchestratorBrief> = {}): OrchestratorBrief {
  assert.ok(model && worker);
  return { task: 'Add a greeting module.', suppliedPlan: null, workers: [{ preset: worker, model }],
    preexistingDirtyPaths: ['README.md'], approval: 'auto', ...overrides };
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
  assert.ok(prompt.includes(`- repo-agent (repo-agent, can modify files; model ${model.id}`), prompt);
  assert.match(prompt, /Command checks run in PowerShell/u);
  assert.match(prompt, /Uncommitted changes that predate this run \(never count them against any task\): README\.md\./u);
  for (const tool of ['save_plan', 'update_tasks', 'dispatch', 'record_review', 'run_check']) assert.ok(prompt.includes(tool), tool);
  assert.match(prompt, /\{"status":"completed","summary":"what was done"\}/u);
  assert.match(prompt, /\{"status":"blocked","reason":"why"\}/u);
});

test('the orchestrator prompt carries the planning rules that keep tasks small and fully verified', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['at most about 6 write', 'Steps are test-first', 'every test suite its change can affect',
    'plus the project\'s typecheck and lint commands', 'finalVerification always includes the project\'s typecheck and lint commands', 'dependsOn names every task']) {
    assert.ok(prompt.includes(rule), rule);
  }
});

test('the orchestrator prompt delegates code exploration to survey tasks and revises plans with update_tasks', () => {
  const prompt = buildOrchestratorPrompt(brief());
  for (const rule of ['Leave code exploration to subagents', 'Survey first', 'at most 2 survey tasks', 'fits in one report',
    'A survey is not reviewed', 'Survey again', 'at most 4 surveys in total', 'add the implementation tasks with update_tasks',
    'Review every reported task that changes files', 'writePaths are guidance, not a limit', 'never to read files or search code',
    'line counts, not the code']) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.equal(prompt.includes('review each'), false, 'surveys are never sent for review');
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
  const instruction = buildChildInstruction({ work: work('implementation'), attempt: 1, kind: 'agent',
    scratchPath: 'C:/scratch', preexistingDirtyPaths: ['README.md'] });
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
  const instruction = buildChildInstruction({ work: work('fix'), attempt: 2, kind: 'agent', scratchPath: 'C:/scratch', preexistingDirtyPaths: [] });
  assert.ok(instruction.startsWith("Fix ONLY task 'greeting'"), instruction);
  assert.match(instruction, /fix attempt 2 of 2\./u);
  assert.doesNotMatch(instruction, /already had uncommitted changes/u);
});

test('each child ends with the report template of its kind, which names the report schema fields', () => {
  const agent = buildChildInstruction({ work: work('implementation'), attempt: 1, kind: 'agent', scratchPath: 's', preexistingDirtyPaths: [] });
  const search = buildChildInstruction({ work: work('implementation'), attempt: 1, kind: 'search', scratchPath: 's', preexistingDirtyPaths: [] });
  assert.match(agent, /Use TDD where behavior changes\./u);
  assert.match(search, /Do not change files\./u);
  const [agentShape, searchShape] = OrchestratorHandoffReportSchema.options.map((option) => Object.keys(option.shape));
  assert.deepEqual(Object.keys(JsonObjectSchema.parse(parseJsonValueText(reportTemplate(agent)))), agentShape);
  assert.deepEqual(Object.keys(JsonObjectSchema.parse(parseJsonValueText(reportTemplate(search)))), searchShape);
});
