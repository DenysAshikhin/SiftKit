import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';

import { CliProgressRenderer } from '../src/cli/progress-renderer.js';
import { StatusServerApiClient } from '../src/cli/status-server-api-client.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { RepoAgentBoundaryWaiter } from '../src/repo-agent/boundary-waiter.js';
import {
  RepoAgentDecisionSchema,
  RepoAgentWorkerRequestSchema,
  type RepoAgentWorkerRequest,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import { runRepoAgentWorkerMain } from '../src/repo-agent/worker-main.js';
import { RepoAgentWorker } from '../src/repo-agent/worker.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { buildMockScorecard } from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { writeSseResult } from './helpers/sse-http.js';

const TEMP_ROOT = join(
  process.cwd(),
  '.tmp',
  `repo-agent-worker-tests-${process.pid}`,
);

type WorkerServerScenario =
  | 'approval'
  | 'complete'
  | 'delayed-error'
  | 'error'
  | 'inactive';

type WorkerHarnessOptions = {
  scenario: WorkerServerScenario;
  finalOutput?: string;
  includeOptionalRequestFields?: boolean;
  idleTimeoutMs?: number;
};

before(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeMockResult(finalOutput: string): RepoSearchExecutionResult {
  return {
    requestId: 'req-1',
    transcriptPath: '/tmp/transcript.jsonl',
    artifactPath: '/tmp/artifact.json',
    scorecard: buildMockScorecard(finalOutput),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => resolve(text));
  });
}

class WorkerMockServer {
  readonly approvalId = randomUUID();
  readonly receivedBodies: JsonObject[] = [];
  readonly submittedDecisions: JsonObject[] = [];

  private readonly scenario: WorkerServerScenario;
  private readonly finalOutput: string;
  private readonly server: http.Server;
  private operationResponse: http.ServerResponse | undefined;

  constructor(scenario: WorkerServerScenario, finalOutput: string) {
    this.scenario = scenario;
    this.finalOutput = finalOutput;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  getPort(): number {
    return getAddressInfo(this.server).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      this.server.closeIdleConnections();
      this.server.closeAllConnections();
    });
  }

  failOperation(): void {
    if (!this.operationResponse) {
      throw new Error('No pending operation response exists.');
    }
    this.writeJson(
      this.operationResponse,
      { error: 'Delayed server error' },
      500,
    );
  }

  async waitForRequest(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.receivedBodies.length > 0) {
        return;
      }
      await delay(10);
    }
    throw new Error('Timed out waiting for the worker request.');
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      this.writeJson(response, { ok: true });
      return;
    }
    if (request.method === 'GET' && request.url === '/config') {
      this.writeJson(response, { Version: '0.1.0' });
      return;
    }
    if (request.method === 'POST' && request.url === '/repo-agent') {
      await this.handleRepoAgent(request, response);
      return;
    }
    if (
      this.scenario === 'approval'
      && request.method === 'POST'
      && request.url === '/repo-search/approval'
    ) {
      await this.handleApproval(request, response);
      return;
    }
    response.writeHead(404);
    response.end();
  }

  private async handleRepoAgent(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.receivedBodies.push(asObject(JSON.parse(await readBody(request))));
    if (this.scenario === 'error') {
      this.writeJson(response, { error: 'Internal server error' }, 500);
      return;
    }
    if (this.scenario === 'approval') {
      this.operationResponse = response;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write('\n');
      response.write(`event: progress\ndata: ${JSON.stringify({
        kind: 'approval_request',
        requestId: 'request-1',
        approvalId: this.approvalId,
        toolName: 'write',
        command: 'write path=src/example.ts',
        reviewPayload: '{"path":"src/example.ts","content":"safe"}',
      })}\n\n`);
      return;
    }
    if (this.scenario === 'delayed-error') {
      this.operationResponse = response;
      return;
    }
    if (this.scenario === 'inactive') {
      this.operationResponse = response;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.flushHeaders();
      return;
    }
    writeSseResult(response, makeMockResult(this.finalOutput));
  }

  private async handleApproval(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.submittedDecisions.push(
      asObject(JSON.parse(await readBody(request))),
    );
    this.writeJson(response, { accepted: true });
    if (!this.operationResponse) {
      throw new Error('Approval arrived before the operation response existed.');
    }
    this.operationResponse.write(
      `event: result\ndata: ${JSON.stringify(makeMockResult(this.finalOutput))}\n\n`,
    );
    this.operationResponse.end();
  }

  private writeJson(
    response: http.ServerResponse,
    body: JsonObject,
    statusCode = 200,
  ): void {
    response.writeHead(statusCode, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}

class WorkerTestHarness {
  readonly request: RepoAgentWorkerRequest;
  readonly server: WorkerMockServer;
  readonly store: RepoAgentRunStore;
  readonly worker: RepoAgentWorker;
  readonly runsRoot: string;

  private readonly oldConfigUrl: string | undefined;
  private readonly oldStatusUrl: string | undefined;

  private constructor(options: {
    request: RepoAgentWorkerRequest;
    server: WorkerMockServer;
    store: RepoAgentRunStore;
    worker: RepoAgentWorker;
    oldConfigUrl: string | undefined;
    oldStatusUrl: string | undefined;
    runsRoot: string;
  }) {
    this.request = options.request;
    this.server = options.server;
    this.store = options.store;
    this.worker = options.worker;
    this.runsRoot = options.runsRoot;
    this.oldConfigUrl = options.oldConfigUrl;
    this.oldStatusUrl = options.oldStatusUrl;
  }

  static async create(options: WorkerHarnessOptions): Promise<WorkerTestHarness> {
    const runsRoot = join(TEMP_ROOT, randomUUID());
    mkdirSync(runsRoot);
    const request = RepoAgentWorkerRequestSchema.parse({
      runId: randomUUID(),
      task: 'implement the task',
      repoRoot: process.cwd(),
      approval: 'auto',
      progress: false,
      ...(options.includeOptionalRequestFields
        ? {
            model: 'test-model',
            logFile: join(runsRoot, 'worker.log'),
          }
        : {}),
    });
    const server = new WorkerMockServer(
      options.scenario,
      options.finalOutput ?? 'Task completed successfully',
    );
    await server.start();
    const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
    const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
    process.env.SIFTKIT_STATUS_BACKEND_URL =
      `http://127.0.0.1:${server.getPort()}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL =
      `http://127.0.0.1:${server.getPort()}/config`;

    const store = new RepoAgentRunStore(runsRoot);
    store.create(request);
    const worker = new RepoAgentWorker({
      store,
      apiClient: new StatusServerApiClient(undefined, {
        repoAgentIdleTimeoutMs: options.idleTimeoutMs,
      }),
      progressRenderer: new CliProgressRenderer(process.stderr, 'repo-agent'),
      boundaryWaiter: new RepoAgentBoundaryWaiter({
        store,
        runId: request.runId,
        pollIntervalMs: 5,
      }),
    });
    return new WorkerTestHarness({
      request,
      server,
      store,
      worker,
      oldConfigUrl,
      oldStatusUrl,
      runsRoot,
    });
  }

  async close(): Promise<void> {
    if (this.oldStatusUrl === undefined) {
      delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    } else {
      process.env.SIFTKIT_STATUS_BACKEND_URL = this.oldStatusUrl;
    }
    if (this.oldConfigUrl === undefined) {
      delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    } else {
      process.env.SIFTKIT_CONFIG_SERVICE_URL = this.oldConfigUrl;
    }
    await this.server.close();
  }

  async waitForApproval() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = this.store.readState(this.request.runId);
      if (state.status === 'approval_required') {
        return state;
      }
      await delay(10);
    }
    throw new Error(
      `Timed out waiting for approval on run ${this.request.runId}.`,
    );
  }
}

test('transitions to running state with process.pid', async () => {
  const harness = await WorkerTestHarness.create({ scenario: 'complete' });
  try {
    await harness.worker.run(harness.request.runId);
    const state = harness.store.readState(harness.request.runId);
    assert.equal(state.status, 'completed');
    assert.equal(state.pid, process.pid);
    assert.ok(state.output.length > 0);
  } finally {
    await harness.close();
  }
});

test('forwards exact stored request to /repo-agent endpoint', async () => {
  const harness = await WorkerTestHarness.create({
    scenario: 'complete',
    includeOptionalRequestFields: true,
  });
  try {
    await harness.worker.run(harness.request.runId);
    const body = harness.server.receivedBodies[0];
    assert.ok(body);
    assert.deepEqual(body, {
      prompt: harness.request.task,
      repoRoot: harness.request.repoRoot,
      approval: harness.request.approval,
      model: harness.request.model,
      logFile: harness.request.logFile,
    });
  } finally {
    await harness.close();
  }
});

test('publishes approval events and resumes the same worker after approval', async () => {
  const harness = await WorkerTestHarness.create({
    scenario: 'approval',
    finalOutput: 'Approved task completed',
  });
  try {
    const pending = harness.worker.run(harness.request.runId);
    const approvalState = await harness.waitForApproval();
    assert.equal(approvalState.pid, process.pid);
    assert.equal(
      approvalState.approval.reviewPayload,
      '{"path":"src/example.ts","content":"safe"}',
    );
    harness.store.submitDecision(RepoAgentDecisionSchema.parse({
      runId: harness.request.runId,
      approvalId: harness.server.approvalId,
      observedRevision: approvalState.revision,
      decision: 'approve',
    }));
    await pending;

    assert.deepEqual(harness.server.submittedDecisions, [{
      requestId: 'request-1',
      approvalId: harness.server.approvalId,
      decision: 'approve',
    }]);
    const completed = harness.store.readState(harness.request.runId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.pid, process.pid);
    assert.equal(completed.output, 'Approved task completed');
  } finally {
    await harness.close();
  }
});

test('stores sanitized completion output without scorecard internals', async () => {
  const harness = await WorkerTestHarness.create({
    scenario: 'complete',
    finalOutput: 'Safe output text',
  });
  try {
    await harness.worker.run(harness.request.runId);
    const state = harness.store.readState(harness.request.runId);
    assert.equal(state.status, 'completed');
    assert.equal(state.output, 'Safe output text');
    assert.equal(state.output.includes('scorecard'), false);
  } finally {
    await harness.close();
  }
});

test('stores failed state on server error', async () => {
  const harness = await WorkerTestHarness.create({ scenario: 'error' });
  try {
    await assert.rejects(
      () => harness.worker.run(harness.request.runId),
      /HTTP 500/iu,
    );
    const state = harness.store.readState(harness.request.runId);
    assert.equal(state.status, 'failed');
    assert.ok(state.error.length > 0);
  } finally {
    await harness.close();
  }
});

test('stores failed state when the repo-agent stream is inactive', async () => {
  const harness = await WorkerTestHarness.create({
    scenario: 'inactive',
    idleTimeoutMs: 25,
  });
  try {
    await assert.rejects(
      Promise.race([
        harness.worker.run(harness.request.runId),
        delay(150).then(() => {
          throw new Error('Worker exceeded the configured inactivity timeout.');
        }),
      ]),
      /inactivity|not reachable/iu,
    );
    const state = harness.store.readState(harness.request.runId);
    assert.equal(state.status, 'failed');
  } finally {
    await harness.close();
  }
});

test('does not overwrite an already-aborted state', async () => {
  const harness = await WorkerTestHarness.create({ scenario: 'error' });
  try {
    harness.store.transition(harness.request.runId, 0, {
      runId: harness.request.runId,
      revision: 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'aborted',
      pid: process.pid,
    });
    await harness.worker.run(harness.request.runId);
    assert.equal(
      harness.store.readState(harness.request.runId).status,
      'aborted',
    );
    assert.equal(harness.server.receivedBodies.length, 0);
  } finally {
    await harness.close();
  }
});

test('rejects a duplicate worker in a non-starting active state', async () => {
  const harness = await WorkerTestHarness.create({ scenario: 'complete' });
  try {
    harness.store.transition(harness.request.runId, 0, {
      runId: harness.request.runId,
      revision: 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'running',
      pid: process.pid,
    });
    await assert.rejects(
      () => harness.worker.run(harness.request.runId),
      /requires starting state.*running/iu,
    );
    assert.equal(harness.server.receivedBodies.length, 0);
  } finally {
    await harness.close();
  }
});

test('does not overwrite abort after a successful operation response', async () => {
  const harness = await WorkerTestHarness.create({ scenario: 'approval' });
  try {
    const pending = harness.worker.run(harness.request.runId);
    const approvalState = await harness.waitForApproval();
    harness.store.submitDecision(RepoAgentDecisionSchema.parse({
      runId: harness.request.runId,
      approvalId: harness.server.approvalId,
      observedRevision: approvalState.revision,
      decision: 'abort',
    }));
    await pending;
    assert.equal(
      harness.store.readState(harness.request.runId).status,
      'aborted',
    );
  } finally {
    await harness.close();
  }
});

test('does not overwrite abort after an operation error', async () => {
  const harness = await WorkerTestHarness.create({
    scenario: 'delayed-error',
  });
  try {
    const pending = harness.worker.run(harness.request.runId);
    await harness.server.waitForRequest();
    const running = harness.store.readState(harness.request.runId);
    assert.equal(running.status, 'running');
    harness.store.transition(harness.request.runId, running.revision, {
      runId: harness.request.runId,
      revision: running.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'aborted',
      pid: process.pid,
    });
    harness.server.failOperation();
    await pending;
    assert.equal(
      harness.store.readState(harness.request.runId).status,
      'aborted',
    );
  } finally {
    await harness.close();
  }
});

test('worker main parses its boundary and runs the stored request', async () => {
  const harness = await WorkerTestHarness.create({ scenario: 'complete' });
  try {
    await runRepoAgentWorkerMain([
      harness.request.runId,
      harness.runsRoot,
    ]);
    assert.equal(
      harness.store.readState(harness.request.runId).status,
      'completed',
    );
  } finally {
    await harness.close();
  }
});

test('worker main rejects extra or malformed arguments', async () => {
  await assert.rejects(
    () => runRepoAgentWorkerMain(['not-a-run-id', TEMP_ROOT, 'extra']),
  );
});

test('worker main process reports malformed boundaries with a non-zero exit', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(process.cwd(), 'src', 'repo-agent', 'worker-main.ts'),
      'not-a-run-id',
      TEMP_ROOT,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Repo-agent worker failed/iu);
});
