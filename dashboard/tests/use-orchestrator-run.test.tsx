import assert from 'node:assert/strict';
import { test } from 'vitest';
import { OrchestratorRunStateSchema, type OrchestratorActivity, type OrchestratorRunState } from '@siftkit/contracts';
import { renderHook, waitFor } from './react-test-environment.ts';
import { useOrchestratorRun } from '../src/hooks/useOrchestratorRun.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000003';
const AT = '2026-09-23T12:00:00.000Z';

function runState(overrides: Partial<OrchestratorRunState>): OrchestratorRunState {
  return OrchestratorRunStateSchema.parse({
    runId: RUN_ID,
    request: { submissionId: RUN_ID, sessionId: null, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive', task: 'Greet', planPath: null },
    revision: 1, phase: 'executing', planPath: null, planHash: null, plan: null, tasks: [], attempts: [], parentRunIds: [],
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

test('a session opens the run it records by id, follows its events, and settles on the result', async () => {
  const completed = runState({ phase: 'completed', revision: 5 });
  const progress = { events: [EVENT], state: runState({ revision: 2 }) };
  const fetches = mockFetch({
    '/orchestrator/status': json(runState({})),
    '/orchestrator/events': () => new Response(`event: progress\ndata: ${JSON.stringify(progress)}\n\nevent: result\ndata: ${JSON.stringify(completed)}\n\n`),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun(RUN_ID));
    await waitFor(() => assert.equal(result.current.state?.phase, 'completed'));
    assert.equal(result.current.lastMessage, 'Task started.');
    assert.equal(result.current.error, null);
    assert.equal(fetches.calls[0]?.url, `/orchestrator/status?runId=${RUN_ID}`);
    assert.deepEqual(JSON.parse(fetches.calls[1]?.body ?? ''), { runId: RUN_ID, afterSequence: 0 });
    assert.equal(fetches.calls.length, 2, 'each progress frame carries the state; no status refetch');
  } finally { fetches.restore(); }
});

test('the board follows the run its session names, never whichever run the folder has', async () => {
  const other = '00000000-0000-4000-8000-000000000009';
  const fetches = mockFetch({
    '/orchestrator/status': json(runState({})),
    '/orchestrator/events': () => new Response(`event: result\ndata: ${JSON.stringify(runState({ phase: 'completed', revision: 5 }))}\n\n`),
  });
  try {
    const { result, rerender } = renderHook(({ runId }: { runId: string | null }) => useOrchestratorRun(runId), {
      initialProps: { runId: RUN_ID },
    });
    await waitFor(() => assert.equal(result.current.state?.phase, 'completed'));
    rerender({ runId: other });
    await waitFor(() => assert.equal(fetches.calls.filter((call) => call.url === `/orchestrator/status?runId=${other}`).length, 1));
    assert.equal(fetches.calls.some((call) => call.url.startsWith('/orchestrator/runs')), false);
  } finally { fetches.restore(); }
});

test('a terminal latest run replays its events once, so the stepper knows where it stopped, and a decision targets the pending approval ID', async () => {
  const failed = runState({ phase: 'failed', approval: null, failure: { code: 'blocked', message: 'Blocked.', taskId: null } });
  const stopped = { ...EVENT, sequence: 2, phase: 'failed', message: 'Blocked.' };
  const fetches = mockFetch({
    '/orchestrator/status': json(failed),
    '/orchestrator/events': () => new Response(`event: progress\ndata: ${JSON.stringify({ events: [EVENT, stopped], state: failed })}\n\nevent: result\ndata: ${JSON.stringify(failed)}\n\n`),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun(RUN_ID));
    await waitFor(() => assert.equal(result.current.workPhase, 'executing'));
    assert.equal(result.current.state?.phase, 'failed');
    assert.equal(result.current.lastMessage, 'Blocked.');
    assert.equal(fetches.calls.length, 2, 'one replay; a terminal stream ends at once');
    assert.throws(() => { void result.current.decide({ decision: 'approve' }); }, /No orchestrator approval is pending/u);
  } finally { fetches.restore(); }

  const pending = runState({ phase: 'approval_required', approval: APPROVAL });
  const decided = mockFetch({
    '/orchestrator/status': json(pending),
    '/orchestrator/events': () => new Response(`event: result\ndata: ${JSON.stringify(pending)}\n\n`),
    '/orchestrator/decide': json(runState({ revision: 4 })),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun(RUN_ID));
    await waitFor(() => assert.equal(result.current.state?.phase, 'approval_required'));
    await result.current.decide({ decision: 'deny', reason: 'No.' });
    const decide = decided.calls.find((call) => call.url === '/orchestrator/decide');
    assert.deepEqual(JSON.parse(decide?.body ?? ''), { runId: RUN_ID, approvalId: APPROVAL_ID, decision: 'deny', reason: 'No.' });
    await waitFor(() => assert.equal(result.current.state?.revision, 4));
  } finally { decided.restore(); }
});

test('a stream that ends without a result surfaces an error', async () => {
  const fetches = mockFetch({
    '/orchestrator/status': json(runState({})),
    '/orchestrator/events': () => new Response(''),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun(RUN_ID));
    await waitFor(() => assert.equal(result.current.error, 'Orchestrator event stream ended without a result.'));
  } finally { fetches.restore(); }
});

test('a session with no run of its own looks nothing up, and a start names the session it came from', async () => {
  const started = runState({ revision: 0, phase: 'preparing_plan' });
  const fetches = mockFetch({
    '/orchestrator/events': () => new Response(`event: result\ndata: ${JSON.stringify(runState({ phase: 'completed', revision: 5 }))}\n\n`),
    '/orchestrator': json(started),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun(null));
    assert.equal(result.current.state, null);
    assert.equal(fetches.calls.length, 0, 'no session run means no lookup, and no run for the folder either');
    await result.current.start({ sessionId: SESSION_ID, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'auto', task: 'Greet', planPath: null });
    const post = fetches.calls.find((call) => call.url === '/orchestrator');
    const body = post?.body === undefined || post.body === null ? null : JSON.parse(post.body);
    assert.ok(body);
    assert.equal(body.sessionId, SESSION_ID, 'a dashboard start names the session it came from');
    assert.equal(body.repoRoot, 'C:/repo');
    assert.equal(body.presetId, 'orchestrator');
    assert.equal(body.approval, 'auto');
    assert.equal(body.task, 'Greet');
    assert.equal(body.planPath, null);
    assert.match(String(body.submissionId), /^[0-9a-f-]{36}$/u);
    await waitFor(() => assert.equal(result.current.state?.phase, 'completed'));
  } finally { fetches.restore(); }
});

const ACTIVITY: OrchestratorActivity = { runId: RUN_ID, schedule: null, parent: null, children: [] };

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
  const fetches = mockFetch({ '/orchestrator/status': json(runState({})), '/orchestrator/events': () => new Response(body) });
  try {
    const { result, unmount } = renderHook(() => useOrchestratorRun(RUN_ID));
    await waitFor(() => assert.deepEqual(result.current.activity, ACTIVITY));
    assert.equal(result.current.workPhase, 'executing');
    assert.equal(result.current.state?.phase, 'approval_required');
    unmount();
  } finally { fetches.restore(); }
});

test('the closing result clears the live view', async () => {
  const completed = runState({ phase: 'completed', revision: 5 });
  const fetches = mockFetch({
    '/orchestrator/status': json(runState({})),
    '/orchestrator/events': () => new Response(`event: activity\ndata: ${JSON.stringify(ACTIVITY)}\n\nevent: result\ndata: ${JSON.stringify(completed)}\n\n`),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun(RUN_ID));
    await waitFor(() => assert.equal(result.current.state?.phase, 'completed'));
    assert.equal(result.current.activity, null);
  } finally { fetches.restore(); }
});
