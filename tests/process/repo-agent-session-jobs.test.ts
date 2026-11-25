import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getDefaultConfigObject } from '../../src/config/defaults.ts';
import { getAbortError } from '../../src/lib/abort.ts';
import { RepoAgentRunRequestSchema } from '../../src/repo-agent/run-schemas.ts';
import { RepoAgentRunStore } from '../../src/repo-agent/run-store.ts';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../../src/repo-search/types.ts';
import { parseRepoSearchRequest } from '../../src/status-server/route-request-normalizers.ts';
import { createRepoSearchAdmissionRecord } from '../../src/status-server/repo-search-admissions.ts';
import { RepositoryGate } from '../../src/status-server/orchestrator-runs.ts';
import { RepoAgentSessionManager, type RepoAgentEngine, type RepoAgentModelLockAdapter, type RepoAgentModelLockHandle, type RepoAgentSession } from '../../src/status-server/repo-agent-sessions.ts';
import { closeAllRuntimeDatabases } from '../../src/state/runtime-db.ts';
import { buildMockScorecard } from '../_test-helpers.ts';
import { agentProcessMarker, countMarkedProcesses, killMarkedProcesses, leaveProcessesCommand } from '../helpers/agent-processes.ts';
import { currentModelTarget } from '../helpers/chat-run-recorder.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

type Ending = 'finish' | 'failure' | 'abort' | 'approval denied' | 'approval timeout' | 'shutdown';

/** Starts one job that leaves two processes behind, then ends the run the way the test asks. */
class JobEngine implements RepoAgentEngine {
  private readonly ending: Ending;
  private readonly marker: string;
  /** Resolves once the job and the processes it leaves are running. */
  readonly jobRunning: Promise<void>;
  private markRunning: () => void = () => undefined;

  constructor(ending: Ending, marker: string) {
    this.ending = ending;
    this.marker = marker;
    this.jobRunning = new Promise((resolve) => { this.markRunning = resolve; });
  }

  async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const jobs = request.backgroundJobs;
    assert.ok(jobs);
    assert.equal(jobs.start({ command: `${leaveProcessesCommand(this.marker)}; Start-Sleep 120`, cwd: request.repoRoot, timeoutMs: 120_000, env: {} }).ok, true);
    while (countMarkedProcesses(this.marker) < 2) await delay(100);
    this.markRunning();
    if (this.ending === 'failure') throw new Error('engine exploded');
    if (this.ending === 'abort') {
      await new Promise((_resolve, reject) => { request.abortSignal?.addEventListener('abort', () => { reject(getAbortError(request.abortSignal)); }, { once: true }); });
    }
    if (this.ending === 'approval denied' || this.ending === 'approval timeout') {
      const decision = await request.approvalGate?.request({ turn: 1, toolName: 'run', command: 'npm test', reviewPayload: null });
      if (decision?.kind === 'abort') throw new Error(decision.reason);
    }
    if (this.ending === 'shutdown') while (jobs.running().length > 0) await delay(50);
    const scorecard = buildMockScorecard('done');
    const task = scorecard.tasks[0];
    assert.ok(task);
    task.reason = 'finish';
    return { requestId: 'r', transcriptPath: 'db://t', artifactPath: 'db://a', scorecard, turnRecords: [] };
  }
}

const LOCKS: RepoAgentModelLockAdapter = {
  acquire: (): Promise<RepoAgentModelLockHandle | null> => Promise.resolve({
    context: currentModelTarget(getDefaultConfigObject()), release: () => undefined, renewActivity: () => undefined,
  }),
  queueLength: () => 0,
};

function startSession(t: TestContext, ending: Ending, marker: string): { manager: RepoAgentSessionManager; session: RepoAgentSession; engine: JobEngine; gate: RepositoryGate; root: string } {
  const root = createManagedTempDir('siftkit-session-jobs-');
  const previousCwd = process.cwd();
  process.chdir(root);
  t.after(() => { closeAllRuntimeDatabases(); process.chdir(previousCwd); });
  const store = new RepoAgentRunStore(path.join(root, 'runs'));
  const engine = new JobEngine(ending, marker);
  const gate = new RepositoryGate();
  const manager = new RepoAgentSessionManager({ store, engine });
  const runId = randomUUID();
  store.create(RepoAgentRunRequestSchema.parse({ runId, task: 'jobs', repoRoot: root, approval: 'interactive' }));
  const routeRequest = parseRepoSearchRequest({ prompt: 'jobs', repoRoot: root });
  assert.ok(routeRequest);
  const admission = createRepoSearchAdmissionRecord(routeRequest, getDefaultConfigObject());
  const session = manager.start({
    runId, requestId: admission.requestId, admission, approvalMode: 'interactive', approvalDelivery: 'boundary', locks: LOCKS, repository: { gate, repoRoot: root, access: 'exclusive' }, approvalGates: new Map(),
    ...(ending === 'approval timeout' ? { decisionTimeoutMs: 500 } : {}),
    engineRequest: { presetId: 'repo-agent', taskKind: 'repo-agent', prompt: 'jobs', repoRoot: root, allowedTools: ['run'] },
  });
  return { manager, session, engine, gate, root };
}

const EXPECTED_STATUS: Record<Ending, string> = {
  finish: 'completed', failure: 'failed', abort: 'aborted', 'approval denied': 'completed', 'approval timeout': 'approval_timeout', shutdown: 'completed',
};

for (const ending of ['finish', 'failure', 'abort', 'approval denied', 'approval timeout', 'shutdown'] as const) {
  test(`no job outlives its run: ${ending}`, async (t) => {
    const marker = agentProcessMarker();
    t.after(() => { killMarkedProcesses(marker); });
    const { manager, session, engine, gate, root } = startSession(t, ending, marker);
    await engine.jobRunning;
    if (ending === 'abort') session.abort();
    if (ending === 'shutdown') await manager.disposeBackgroundJobs();
    if (ending === 'approval denied') {
      await session.waitForBoundary(1);
      session.submitDecision({ runId: session.runId, decision: 'deny', reason: 'no' });
    }
    // The next run gets the repository the moment this one lets go of it.
    const next = await gate.acquire(root, 'exclusive', new AbortController().signal);
    assert.equal(countMarkedProcesses(marker), 0, 'every process was gone before the repository came back');
    next.release();
    await session.settled;
    assert.equal(session.getState().status, EXPECTED_STATUS[ending]);
  });
}
