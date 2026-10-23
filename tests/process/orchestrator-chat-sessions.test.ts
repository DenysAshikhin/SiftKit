import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { z } from 'zod';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatSessionSummary, OrchestratorRunState, OrchestratorStartRequest } from '@siftkit/contracts';
import {
  ActiveChatOperationsResponseSchema,
  ChatSessionResponseSchema,
  ChatSessionSummarySchema,
  OrchestratorRunStateSchema,
  OrchestratorStartRequestSchema,
  isOrchestratorTerminalPhase,
} from '@siftkit/contracts';
import { OrchestratorRunStore } from '../../src/orchestrator/run-store.ts';
import { parseJsonText } from '../../src/lib/json.ts';
import { getRuntimeDatabase } from '../../src/state/runtime-db.ts';
import { linkChatSessionToOrchestratorRun, listActiveChatSessionOrchestratorRuns } from '../../src/state/chat-sessions.ts';
import { startHarness, type StreamedOperationHarness } from '../helpers/streamed-op-harness.ts';

const RailSchema = z.object({ sessions: z.array(ChatSessionSummarySchema) });
const CountSchema = z.object({ runs: z.number() });

/** Starts an orchestrator run over the same endpoint the dashboard and the CLI use. */
async function postStart(
  harness: StreamedOperationHarness,
  request: OrchestratorStartRequest,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${harness.baseUrl}/orchestrator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  return { status: response.status, body: await response.text() };
}

/** A run request of the shape both clients send; `sessionId: null` is the CLI's, a real id the dashboard's. */
function startRequest(overrides: Partial<OrchestratorStartRequest> = {}): OrchestratorStartRequest {
  return OrchestratorStartRequestSchema.parse({ submissionId: randomUUID(), sessionId: null, repoRoot: process.cwd(),
    presetId: 'orchestrator', approval: 'auto', task: 'Add a greeting module.', planPath: null, ...overrides });
}

/** The session rail, read exactly as the dashboard reads it. */
async function rail(harness: StreamedOperationHarness): Promise<ChatSessionSummary[]> {
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions`);
  assert.equal(response.status, 200);
  return RailSchema.parse(await response.json()).sessions;
}

async function activeOperations(harness: StreamedOperationHarness) {
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/operations`);
  assert.equal(response.status, 200);
  return ActiveChatOperationsResponseSchema.parse(await response.json()).operations;
}

/** Stops a run and waits for it to settle, so the server holds nothing live when the test ends. */
async function settleRun(harness: StreamedOperationHarness, runId: string): Promise<void> {
  const aborted = await fetch(`${harness.baseUrl}/orchestrator/abort`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }),
  });
  await aborted.text();
  await waitForTerminalRun(harness, runId);
}

/** A chat session made the way the dashboard makes one, read back from the rail it appears on. */
async function createSession(harness: StreamedOperationHarness): Promise<string> {
  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.ok(response.ok, `Creating a chat session failed: ${await response.text()}`);
  const sessions = await rail(harness);
  assert.equal(sessions.length, 1, 'the dashboard made exactly one session');
  const [session] = sessions;
  assert.ok(session);
  assert.equal(session.orchestratorRunId, null, 'a session nobody has run from shows no run');
  return session.id;
}

function storedRuns(): OrchestratorRunStore {
  return new OrchestratorRunStore(getRuntimeDatabase());
}

function orchestratorRunCount(): number {
  return CountSchema.parse(getRuntimeDatabase().prepare('SELECT COUNT(*) AS runs FROM orchestrator_runs').get()).runs;
}

/** Waits for a run to settle, reading it the way the dashboard's board does. */
async function waitForTerminalRun(harness: StreamedOperationHarness, runId: string): Promise<OrchestratorRunState> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await fetch(`${harness.baseUrl}/orchestrator/status?runId=${runId}`);
    assert.equal(response.status, 200);
    const state = OrchestratorRunStateSchema.parse(await response.json());
    if (isOrchestratorTerminalPhase(state.phase)) return state;
    if (Date.now() > deadline) throw new Error(`Run ${runId} never settled; last phase ${state.phase}.`);
    await delay(20);
  }
}

test('a run started without a session gets exactly one session of its own, showing that run', async (t) => {
  const harness = await startHarness('siftkit-orchestrator-session-new-', t);
  assert.deepEqual(await rail(harness), [], 'a fresh runtime root shows no sessions');

  const started = parseJsonText((await postStart(harness, startRequest())).body, OrchestratorRunStateSchema);

  const sessions = await rail(harness);
  assert.equal(sessions.length, 1, 'one run makes one session, and no other');
  const session = sessions[0];
  assert.ok(session);
  assert.equal(session.title, 'Add a greeting module.', 'the task titles the session');
  assert.equal(session.presetId, 'orchestrator');
  assert.equal(session.orchestratorRunId, started.runId, 'the session records the run it shows');
  assert.equal(session.planRepoRoot, resolve(process.cwd()), 'the session is scoped to the run\'s repository');

  // The same submission sent again is the same request, and still belongs to the one session it made.
  const replay = parseJsonText((await postStart(harness,
    startRequest({ submissionId: started.request.submissionId }))).body, OrchestratorRunStateSchema);
  assert.equal(replay.runId, started.runId, 'a replayed submission returns the run it already made');
  assert.equal((await rail(harness)).length, 1, 'a replayed submission makes no second session');

  // The run was started against a provider that does not answer, so it settles on its own.
  const settled = await waitForTerminalRun(harness, started.runId);
  assert.deepEqual((await activeOperations(harness)).filter((operation) => operation.operationId === settled.runId), [],
    'a settled run leaves its session idle');
  assert.equal((await rail(harness))[0]?.orchestratorRunId, started.runId,
    'a settled run is still the run its session shows');
});

test('a run started from a session shows on that session, and a second run re-points it', async (t) => {
  const harness = await startHarness('siftkit-orchestrator-session-link-', t);
  const sessionId = await createSession(harness);
  assert.equal((await rail(harness))[0]?.orchestratorRunId ?? null, null, 'a manual session shows no run until one starts');

  const first = parseJsonText((await postStart(harness,
    startRequest({ sessionId }))).body, OrchestratorRunStateSchema);
  const sessions = await rail(harness);
  assert.equal(sessions.length, 1, 'a run from an existing session adds none');
  assert.equal(sessions[0]?.id, sessionId);
  assert.equal(sessions[0]?.orchestratorRunId, first.runId);

  const second = parseJsonText((await postStart(harness,
    startRequest({ sessionId, task: 'Add a farewell module.' }))).body, OrchestratorRunStateSchema);
  assert.notEqual(second.runId, first.runId);
  const shown = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(shown.status, 200);
  assert.equal((await rail(harness))[0]?.orchestratorRunId, second.runId, 'the session follows the newest run it started');
  assert.equal(storedRuns().read(first.runId).request.sessionId, sessionId,
    'the replaced run still records the session it belonged to');

  await settleRun(harness, second.runId);
  await settleRun(harness, first.runId);
});

test('a start that names a session nobody has cannot create a run', async (t) => {
  const harness = await startHarness('siftkit-orchestrator-session-unknown-', t);
  const missing = randomUUID();

  const rejected = await postStart(harness, startRequest({ sessionId: missing }));

  assert.equal(rejected.status, 400);
  assert.match(rejected.body, new RegExp(missing, 'u'));
  assert.deepEqual(await rail(harness), [], 'a rejected start creates no session');
  assert.equal(orchestratorRunCount(), 0, 'a rejected start creates no run');
});

test('a start for a repository folder that does not exist creates no run and no session', async (t) => {
  const harness = await startHarness('siftkit-orchestrator-session-missing-repo-', t);
  const missing = resolve(process.cwd(), 'no-such-repository-folder');

  const rejected = await postStart(harness, startRequest({ repoRoot: missing }));

  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /does not exist/u);
  assert.deepEqual(await rail(harness), [], 'a rejected start creates no session');
  assert.equal(orchestratorRunCount(), 0, 'a rejected start creates no run');
});

test('the session keeps naming its run across a server restart, and reports it busy only while it runs', async (t) => {
  const harness = await startHarness('siftkit-orchestrator-session-restart-', t);
  const store = storedRuns();
  const sessionId = await createSession(harness);
  const unstored = store.create(startRequest());
  assert.deepEqual(listActiveChatSessionOrchestratorRuns(getRuntimeDatabase()), [],
    'a run no session names is never session work');

  // A run that never settled, as a server that stops mid-run leaves it: live now, interrupted on restart.
  const created = store.create(startRequest());
  linkChatSessionToOrchestratorRun(getRuntimeDatabase(), sessionId, created.runId);
  assert.deepEqual((await activeOperations(harness)).filter((operation) => operation.operationId === unstored.runId), [],
    'only the session that names a run reports it');

  await harness.restart();

  const after = await rail(harness);
  assert.equal(after.find((session) => session.id === sessionId)?.orchestratorRunId, created.runId,
    'the link survives the restart');
  assert.deepEqual((await activeOperations(harness)).filter((operation) => operation.operationId === created.runId), [],
    'a run interrupted by the restart is not busy work');
});

test('a session reports a run of its own as busy work, and stops when the run settles', async (t) => {
  const harness = await startHarness('siftkit-orchestrator-session-busy-', t);
  const store = storedRuns();
  const sessionId = await createSession(harness);
  const created = store.create(startRequest());
  linkChatSessionToOrchestratorRun(getRuntimeDatabase(), sessionId, created.runId);

  const reported = (await activeOperations(harness)).find((operation) => operation.sessionId === sessionId);
  assert.deepEqual(reported, { sessionId, operationKind: 'orchestrator', operationId: created.runId,
    startedAtUtc: created.createdAtUtc }, 'the busy signal is the session\'s own run and its own start');

  const settled = store.update(created.runId, created.revision, { phase: 'completed' }, { message: 'Done.' });
  assert.equal(settled.phase, 'completed');
  assert.deepEqual(listActiveChatSessionOrchestratorRuns(getRuntimeDatabase()), []);
  assert.deepEqual(await activeOperations(harness), [], 'a terminal run leaves the rail idle');
});
// A run's session has no chat turns, so its speed is its parent phases' and children's measured inference.
test('a session showing a run reports that run\'s prefill and decode rates', async (t) => {
  const harness = await startHarness('siftkit-orchestrator-session-throughput-', t);
  const store = storedRuns();
  const sessionId = await createSession(harness);
  const created = store.create(startRequest());
  linkChatSessionToOrchestratorRun(getRuntimeDatabase(), sessionId, created.runId);
  const phaseRunId = randomUUID();
  store.update(created.runId, created.revision, { phase: 'completed', phaseRunIds: [phaseRunId] }, { message: 'Done.' });
  const metric = (tokenCount: number, durationMs: number) => ({ tokenCount, durationMs, tabbyWeightedTokens: tokenCount,
    tabbyDurationMs: durationMs, requestCount: 1, missingInternalRequests: 0, missingTabbyRequests: 0 });
  getRuntimeDatabase().prepare(`INSERT INTO run_logs (run_id, request_id, run_kind, run_group, terminal_state, title, source_paths_json, flushed_at_utc, throughput_json)
    VALUES (?, ?, 'repo_search', 'repo_search', 'completed', 'run', '[]', '2026-10-23T00:00:00.000Z', ?)`)
    .run(phaseRunId, phaseRunId, JSON.stringify({ pp: metric(1_500, 1_000), decode: metric(80, 2_000) }));

  const response = await fetch(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(response.status, 200);
  const { session } = ChatSessionResponseSchema.parse(await response.json());
  assert.deepEqual(session.sessionThroughput, { promptTokensPerSecond: 1_500, generationTokensPerSecond: 40 });
});
