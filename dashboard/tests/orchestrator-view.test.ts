import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  OrchestratorAttemptSchema,
  OrchestratorRunStateSchema,
  OrchestratorTaskStatusSchema,
  type OrchestratorActivity,
  type OrchestratorChildActivity,
  type OrchestratorRunState,
  type OrchestratorSchedule,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';
import {
  attemptSummary,
  contextPercent,
  formatElapsed,
  nowDoing,
  orchestratorSteps,
  phaseTone,
  runElapsedMs,
  taskTone,
  waitReason,
} from '../src/orchestrator-view.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-10-11T12:00:00.000Z';
const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;

function planTask(id: string, workerPresetId: string, dependsOn: string[] = []) {
  return { id, title: id, dependsOn, workerPresetId, readPaths: [], writePaths: [], temporaryPaths: [],
    steps: [{ instruction: 'Do it.', expectedResult: 'Done.' }], verification: [CHECK], acceptance: ['Done.'] };
}

function runState(statuses: Record<string, OrchestratorTaskStatus>, overrides: Partial<OrchestratorRunState> = {}): OrchestratorRunState {
  const tasks = [planTask('read', 'repo-search'), planTask('write', 'repo-agent'), planTask('write-2', 'repo-agent'),
    planTask('after', 'repo-search', ['write'])];
  return OrchestratorRunStateSchema.parse({
    runId: RUN_ID,
    request: { submissionId: RUN_ID, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'auto', task: 'Go', planPath: null },
    revision: 1, phase: 'executing', planPath: 'plan.md', planHash: 'h',
    plan: { goal: 'Go', constraints: [], tasks, finalVerification: [CHECK] },
    tasks: tasks.map((task) => ({ taskId: task.id, status: statuses[task.id] ?? 'pending', driftReview: null, reviewedDigests: [] })),
    attempts: [], phaseRunIds: [], approval: null, failure: null, createdAtUtc: AT, updatedAtUtc: '2026-10-11T12:14:02.000Z',
    ...overrides,
  });
}

const SCHEDULE: OrchestratorSchedule = {
  claims: [{ taskId: 'write', modelId: 'm', mutating: true, contextTokens: 4000 }],
  models: [{ modelId: 'm', slots: 1, used: 1 }], writerUsed: true,
  waits: [
    { taskId: 'read', wait: { kind: 'model_slot', modelId: 'm' } },
    { taskId: 'write-2', wait: { kind: 'writer_slot' } },
    { taskId: 'after', wait: { kind: 'dependencies', taskIds: ['write'] } },
  ],
};
const ACTIVITY: OrchestratorActivity = { runId: RUN_ID, schedule: SCHEDULE, children: [] };

const CHILD: OrchestratorChildActivity = {
  childRunId: CHILD_ID, taskId: 'write', waitingForModel: false, turn: 3, maxTurns: 40, promptTokens: 1000, tools: [],
};

function taskOf(state: OrchestratorRunState, id: string) {
  const task = state.tasks.find((candidate) => candidate.taskId === id);
  if (task === undefined) throw new Error(`No task ${id}`);
  return task;
}

test('the stepper marks done, current, and failed steps, using the last work phase while paused or stopped', () => {
  const statuses = (phase: Parameters<typeof orchestratorSteps>[0], work: Parameters<typeof orchestratorSteps>[1]) =>
    orchestratorSteps(phase, work).map((step) => step.status);
  assert.deepEqual(orchestratorSteps('executing', null).map((step) => step.label), ['Plan', 'Validate', 'Execute', 'Verify', 'Clean']);
  assert.deepEqual(statuses('executing', null), ['done', 'done', 'now', 'todo', 'todo']);
  assert.deepEqual(statuses('approval_required', 'verifying'), ['done', 'done', 'done', 'now', 'todo']);
  assert.deepEqual(statuses('failed', 'executing'), ['done', 'done', 'failed', 'todo', 'todo']);
  assert.deepEqual(statuses('completed', null), ['done', 'done', 'done', 'done', 'done']);
});

test('a pending task shows the wait the scheduler recorded for it', () => {
  const state = runState({ write: 'running' });
  assert.equal(waitReason(taskOf(state, 'after'), state, ACTIVITY), 'needs write');
  assert.equal(waitReason(taskOf(state, 'write-2'), state, ACTIVITY), 'waiting for writer slot');
  assert.equal(waitReason(taskOf(state, 'read'), state, ACTIVITY), 'waiting for m slot');
  assert.equal(waitReason(taskOf(state, 'read'), state, { ...ACTIVITY, schedule: { ...SCHEDULE, waits: [] } }), 'queued');
  assert.equal(waitReason(taskOf(state, 'read'), state, null), 'queued');
  assert.equal(waitReason(taskOf(state, 'write'), state, ACTIVITY), null);
  const stopped = runState({}, { phase: 'failed' });
  assert.equal(waitReason(taskOf(stopped, 'read'), stopped, ACTIVITY), 'not started');
});

test('attempt summary counts each purpose against the attempt limit', () => {
  const attempt = (purpose: 'implementation' | 'drift_fix', number: 1 | 2) => OrchestratorAttemptSchema.parse({
    taskId: 'write', purpose, attempt: number, childRunId: CHILD_ID, reservedAtUtc: AT, status: 'running', result: null,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task: planTask('write', 'repo-agent') },
  });
  assert.equal(attemptSummary('write', []), '—');
  assert.equal(attemptSummary('write', [attempt('implementation', 1), attempt('implementation', 2), attempt('drift_fix', 1)]),
    'impl 2/2 · fix 1/2');
  assert.equal(attemptSummary('read', [attempt('implementation', 1)]), '—');
});

test('now doing prefers the running tool, then the model wait, then the turn, then the task status', () => {
  const running = runState({ write: 'running' });
  const tool = { toolCallId: 't1', turn: 3, activityKind: 'command', command: 'npm test', status: 'running' } as const;
  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, tools: [tool] }), 'command npm test');
  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, waitingForModel: true }), 'waiting for model');
  assert.equal(nowDoing(taskOf(running, 'write'), CHILD), 'thinking · turn 3');
  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, turn: 0 }), 'starting');
  const labels = OrchestratorTaskStatusSchema.options.map((status) => [status, nowDoing(taskOf(runState({ write: status }), 'write'), null)]);
  assert.deepEqual(labels, [
    ['pending', null], ['running', 'starting'], ['verifying', 'verifying checks'], ['reviewing_drift', 'reviewing drift'],
    ['correcting_drift', 'starting correction'], ['retry_pending', 'retry pending'], ['completed', null], ['failed', null], ['aborted', null],
  ], 'every live status without a child says what is happening');
});

test('labels: context percent, elapsed time, run elapsed, and tones for every status and phase', () => {
  assert.equal(contextPercent(CHILD, { taskId: 'write', modelId: 'm', mutating: true, contextTokens: 4000 }), 25);
  assert.equal(formatElapsed(47_000), '47s');
  assert.equal(formatElapsed(842_000), '14m 02s');
  assert.equal(formatElapsed(3_780_000), '1h 03m');
  assert.equal(runElapsedMs(runState({}, { phase: 'completed' }), Date.parse(AT) + 1), 842_000);
  assert.equal(runElapsedMs(runState({}), Date.parse(AT) + 5_000), 5_000);
  assert.deepEqual(OrchestratorTaskStatusSchema.options.map((status) => taskTone(status)),
    ['idle', 'run', 'run', 'run', 'run', 'run', 'ok', 'bad', 'bad']);
  assert.deepEqual((['executing', 'approval_required', 'completed', 'failed', 'aborted', 'interrupted'] as const).map((phase) => phaseTone(phase)),
    ['run', 'run', 'ok', 'bad', 'bad', 'bad']);
});
