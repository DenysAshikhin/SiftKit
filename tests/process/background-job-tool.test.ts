import { IsolatedRuntime } from '../helpers/isolated-runtime.ts';
import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { executeRepoSearchRequest } from '../../src/repo-search/execute.ts';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../../src/planner-protocol/repo-search.ts';
import type { MockPlannerResponseInput } from '../../src/planner-protocol/mock-response.ts';
import { BackgroundJobs, BackgroundJobSlots } from '../../src/repo-search/engine/background-jobs.ts';
import type { SubmissionGate } from '../../src/repo-search/engine/submission-gate.ts';
import { mockSiftConfig } from '../helpers/mock-config.ts';
import { DEAD_BASE_URL, DeadEndpointEnv } from '../helpers/dead-endpoints.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';
import { repoAgentFinishResponses } from '../helpers/repo-agent-mock-responses.ts';

const isolatedRuntime = new IsolatedRuntime();
const deadEndpoints = new DeadEndpointEnv();
before(() => { isolatedRuntime.start(); deadEndpoints.apply(); });
after(async () => { await isolatedRuntime.close(); deadEndpoints.restore(); });

const CONFIG = mockSiftConfig({ Server: { ModelPresets: { Presets: [{ BaseUrl: DEAD_BASE_URL, NumCtx: 32000 }] } } });
const call = (name: string, args: Record<string, string | number | boolean>): MockPlannerResponseInput => ({ toolCalls: [{ name, arguments: args }] });

async function runAgent(t: TestContext, mockResponses: MockPlannerResponseInput[], options: { jobs?: BackgroundJobs; submissionGate?: SubmissionGate; maxTurns?: number } = {}) {
  const slots = new BackgroundJobSlots();
  const jobs = options.jobs ?? new BackgroundJobs(slots);
  t.after(() => jobs.dispose());
  const result = await executeRepoSearchRequest({
    presetId: 'repo-search', taskKind: 'repo-agent', prompt: 'use a background job', repoRoot: createManagedTempDir('siftkit-job-tool-'),
    config: CONFIG, maxTurns: options.maxTurns ?? 12, allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES], availableModels: ['mock'],
    mockResponses, mockCommandResults: {}, backgroundJobs: jobs, submissionGate: options.submissionGate,
  });
  const task = result.scorecard.tasks[0];
  assert.ok(task);
  return { task, jobs, slots, outputs: task.commands.map((command) => command.output), slotsInUse: slots.inUse };
}

test('an agent starts a job, keeps working, and reads its result', async (t) => {
  const { task, outputs } = await runAgent(t, [
    call('run', { command: "node -e 'console.log(123)'; exit 2", background: true }),
    call('write', { path: 'note.txt', content: 'during\n' }),
    call('job', { action: 'wait', jobId: 'j1', waitMs: 30_000 }),
    call('job', { action: 'wait', jobId: 'j1', waitMs: 30_000 }),
    ...repoAgentFinishResponses('done'),
  ]);
  assert.match(outputs[0] ?? '', /Started background job j1 \(limit 1800 s\)/u);
  assert.match(outputs[2] ?? '', /^123\n(?:Files this run wrote while it ran: note\.txt\n)?\[job j1 exited 2 after \d+ s\]/u);
  assert.match(outputs[3] ?? '', /^123\n[^]*\[job j1 exited 2/u, 'an identical wait is answered, not refused as a duplicate');
  assert.equal(task.commands[2]?.exitCode, 2);
  assert.equal(task.finalOutput, 'done');
  assert.ok(task.commands.every((command) => command.safe));
});

test('a first finish with a running job is refused; a second kills it, says so, and only then reaches the checks', async (t) => {
  const jobs = new BackgroundJobs(new BackgroundJobSlots());
  const runningAtReview: number[] = [];
  const submissionGate: SubmissionGate = {
    review(answer) {
      runningAtReview.push(jobs.running().length);
      return Promise.resolve({ kind: 'accept', output: answer });
    },
  };
  const { task } = await runAgent(t, [
    call('run', { command: 'Start-Sleep 60', background: true }),
    { content: 'first try' },
    { content: 'second try' },
  ], { jobs, submissionGate });
  assert.equal(task.reason, 'finish');
  assert.match(task.finalOutput, /^second try\n\nBackground jobs killed because the run ended: j1 \(Start-Sleep 60\)$/u);
  assert.deepEqual(runningAtReview, [0]);
});

test('reaching the turn limit kills running jobs before the answer is written', async (t) => {
  const { task, jobs } = await runAgent(t, [
    call('run', { command: 'Start-Sleep 60', background: true }),
    call('job', { action: 'list' }),
    ...repoAgentFinishResponses('best effort'),
    ...repoAgentFinishResponses('best effort'),
    ...repoAgentFinishResponses('best effort'),
  ], { maxTurns: 2 });
  assert.match(task.finalOutput, /Background jobs killed because the run ended/u);
  assert.equal(jobs.running().length, 0);
});

test('bad job calls are answered with what to do', async (t) => {
  const { outputs } = await runAgent(t, [
    call('job', { action: 'output', jobId: 'j9' }),
    call('run', { command: 'node --version', background: true, outputMode: 'full' }),
    call('run', { command: 'node --version', timeoutMs: 700_000 }),
    ...repoAgentFinishResponses('done'),
  ]);
  assert.match(outputs[0] ?? '', /no background job "j9"; known jobs: none/u);
  assert.match(outputs[1] ?? '', /outputMode does not apply to a background run/u);
  assert.match(outputs[2] ?? '', /timeoutMs is at most 600000 unless background is true/u);
});
