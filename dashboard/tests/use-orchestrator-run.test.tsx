import assert from 'node:assert/strict';
import { test } from 'vitest';
import { OrchestratorRunStateSchema, type OrchestratorActivity, type OrchestratorRunState } from '@siftkit/contracts';
import { renderHook, waitFor } from './react-test-environment.ts';
import { useOrchestratorRun } from '../src/hooks/useOrchestratorRun.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000003';
const AT = '2026-09-23T12:00:00.000Z';

function runState(overrides: Partial<OrchestratorRunState>): OrchestratorRunState {
  return OrchestratorRunStateSchema.parse({
    runId: RUN_ID,
    request: { submissionId: RUN_ID, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive', task: 'Greet', planPath: null },
    revision: 1, phase: 'executing', planPath: null, planHash: null, plan: null, tasks: [], attempts: [], phaseRunIds: [],
    approval: null, failure: null, createdAtUtc: AT, updatedAtUtc: AT, ...overrides,
  });
}

const EVENT = { runId: RUN_ID, sequence: 1, atUtc: AT, phase: 'executing', message: 'Task started.', taskId: null, purpose: null, attempt: null, childRunId: null };
const APPROVAL = { kind: 'check', approvalId: APPROVAL_ID, taskId: null, command: 'npm test', cwd: '.' } as const;

type Call = { url: string; body: string | null };

function mockFetch(routes: Record<string, () => Response>): { calls: Call[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : null });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (route === undefined) throw new Error(`Unexpected fetch ${url}`);
    return route[1]();
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (value: object) => () => new Response(JSON.stringify(value), { status: 200 });

test('a reload reattaches to the latest live run, follows its events, and settles on the result', async () => {
  const completed = runState({ phase: 'completed', revision: 5 });
  const progress = { events: [EVENT], state: runState({ revision: 2 }) };
  const fetches = mockFetch({
    '/orchestrator/runs': json({ runs: [runState({})] }),
    '/orchestrator/events': () => new Response(`event: progress\ndata: ${JSON.stringify(progress)}\n\nevent: result\ndata: ${JSON.stringify(completed)}\n\n`),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.equal(result.current.state?.phase, 'completed'));
    assert.equal(result.current.lastMessage, 'Task started.');
    assert.equal(result.current.error, null);
    assert.equal(fetches.calls[0]?.url, '/orchestrator/runs?repoRoot=C%3A%2Frepo');
    assert.deepEqual(JSON.parse(fetches.calls[1]?.body ?? ''), { runId: RUN_ID, afterSequence: 0 });
    assert.equal(fetches.calls.length, 2, 'each progress frame carries the state; no status refetch');
  } finally { fetches.restore(); }
});

test('a terminal latest run replays its events once, so the stepper knows where it stopped, and a decision targets the pending approval ID', async () => {
  const failed = runState({ phase: 'failed', approval: null, failure: { code: 'blocked', message: 'Blocked.', taskId: null, purpose: null, findingIds: [] } });
  const stopped = { ...EVENT, sequence: 2, phase: 'failed', message: 'Blocked.' };
  const fetches = mockFetch({
    '/orchestrator/runs': json({ runs: [failed] }),
    '/orchestrator/events': () => new Response(`event: progress\ndata: ${JSON.stringify({ events: [EVENT, stopped], state: failed })}\n\nevent: result\ndata: ${JSON.stringify(failed)}\n\n`),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.equal(result.current.workPhase, 'executing'));
    assert.equal(result.current.state?.phase, 'failed');
    assert.equal(result.current.lastMessage, 'Blocked.');
    assert.equal(fetches.calls.length, 2, 'one replay; a terminal stream ends at once');
    assert.throws(() => { void result.current.decide({ decision: 'approve' }); }, /No orchestrator approval is pending/u);
  } finally { fetches.restore(); }

  const pending = runState({ phase: 'approval_required', approval: APPROVAL });
  const decided = mockFetch({
    '/orchestrator/runs': json({ runs: [pending] }),
    '/orchestrator/events': () => new Response(`event: result\ndata: ${JSON.stringify(pending)}\n\n`),
    '/orchestrator/decide': json(runState({ revision: 4 })),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.equal(result.current.state?.phase, 'approval_required'));
    await result.current.decide({ decision: 'deny', reason: 'No.' });
    const decide = decided.calls.find((call) => call.url === '/orchestrator/decide');
    assert.deepEqual(JSON.parse(decide?.body ?? ''), { runId: RUN_ID, approvalId: APPROVAL_ID, decision: 'deny', reason: 'No.' });
    await waitFor(() => assert.equal(result.current.state?.revision, 4));
  } finally { decided.restore(); }
});

test('a stream that ends without a result surfaces an error', async () => {
  const fetches = mockFetch({
    '/orchestrator/runs': json({ runs: [runState({})] }),
    '/orchestrator/events': () => new Response(''),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.equal(result.current.error, 'Orchestrator event stream ended without a result.'));
  } finally { fetches.restore(); }
});

test('no repository means no run lookup and start fails loudly', () => {
  const fetches = mockFetch({});
  try {
    const { result } = renderHook(() => useOrchestratorRun(null));
    assert.equal(result.current.state, null);
    assert.throws(() => { void result.current.start({ presetId: 'orchestrator', approval: 'auto', task: 'x', planPath: null }); }, /needs a repository folder/u);
    assert.equal(fetches.calls.length, 0);
  } finally { fetches.restore(); }
});

const ACTIVITY: OrchestratorActivity = { runId: RUN_ID, schedule: null, children: [] };

test('activity frames update the live view, and an approval pause keeps the last work phase', async () => {
  const paused = { ...EVENT, sequence: 2, phase: 'approval_required', message: 'Waiting for your approval decision.' };
  const progress = { events: [EVENT, paused], state: runState({ revision: 2, phase: 'approval_required', approval: APPROVAL }) };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`));
      controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(ACTIVITY)}\n\n`));
    },
  });
  const fetches = mockFetch({ '/orchestrator/runs': json({ runs: [runState({})] }), '/orchestrator/events': () => new Response(body) });
  try {
    const { result, unmount } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.deepEqual(result.current.activity, ACTIVITY));
    assert.equal(result.current.workPhase, 'executing');
    assert.equal(result.current.state?.phase, 'approval_required');
    unmount();
  } finally { fetches.restore(); }
});

test('the closing result clears the live view', async () => {
  const completed = runState({ phase: 'completed', revision: 5 });
  const fetches = mockFetch({
    '/orchestrator/runs': json({ runs: [runState({})] }),
    '/orchestrator/events': () => new Response(`event: activity\ndata: ${JSON.stringify(ACTIVITY)}\n\nevent: result\ndata: ${JSON.stringify(completed)}\n\n`),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.equal(result.current.state?.phase, 'completed'));
    assert.equal(result.current.activity, null);
  } finally { fetches.restore(); }
});
