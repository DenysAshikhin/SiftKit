import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, before } from 'node:test';

import { parseRepoAgentInvocation } from '../src/cli/repo-agent-args.js';
import {
  RepoAgentCommand,
  type RepoAgentCommandStreams,
} from '../src/cli/repo-agent-command.js';
import { parseJsonValueText } from '../src/lib/json.js';
import {
  RepoAgentApprovalSchema,
  RepoAgentRunResultSchema,
  type RepoAgentDecision,
  type RepoAgentWorkerRequest,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import type { RepoAgentProcessLauncher } from '../src/repo-agent/worker-launcher.js';
import {
  makeCaptureStream,
  type CaptureStream,
} from './_test-helpers.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

const TEMP_ROOT = join(
  process.cwd(),
  '.tmp',
  `repo-agent-command-tests-${process.pid}`,
);

type FixtureLaunchMode = 'approval' | 'completed' | 'failed';

type CommandHarness = {
  command: RepoAgentCommand;
  launcher: FixtureLauncher;
  store: SettlingRunStore;
};

type CapturedStreams = {
  streams: RepoAgentCommandStreams;
  stdout: CaptureStream;
  stderr: CaptureStream;
};

class HealthServer {
  private readonly server: http.Server;

  constructor() {
    this.server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
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
    });
  }
}

class SettlingRunStore extends RepoAgentRunStore {
  readonly submittedDecisions: RepoAgentDecision[] = [];

  override submitDecision(input: RepoAgentDecision): void {
    super.submitDecision(input);
    this.submittedDecisions.push(input);
    if (input.decision === 'abort') {
      this.clearPendingApproval(
        input.runId,
        input.observedRevision,
        'aborted',
      );
      return;
    }
    const running = this.clearPendingApproval(
      input.runId,
      input.observedRevision,
      'running',
    );
    this.transition(input.runId, running.revision, {
      runId: input.runId,
      revision: running.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'completed',
      pid: process.pid,
      output: input.decision === 'deny'
        ? `denied: ${input.reason}`
        : 'approved and completed',
    });
  }
}

class FixtureLauncher implements RepoAgentProcessLauncher {
  readonly launchedRunIds: string[] = [];

  private readonly mode: FixtureLaunchMode;
  private readonly store: RepoAgentRunStore;

  constructor(mode: FixtureLaunchMode, store: RepoAgentRunStore) {
    this.mode = mode;
    this.store = store;
  }

  launch(runId: string): number {
    this.launchedRunIds.push(runId);
    const starting = this.store.readState(runId);
    const running = this.store.transition(runId, starting.revision, {
      runId,
      revision: starting.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'running',
      pid: process.pid,
    });
    if (this.mode === 'completed') {
      this.store.transition(runId, running.revision, {
        runId,
        revision: running.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'completed',
        pid: process.pid,
        output: 'fixture completed',
      });
      return process.pid;
    }
    if (this.mode === 'approval') {
      this.store.publishApproval(
        runId,
        running.revision,
        RepoAgentApprovalSchema.parse({
          approvalId: randomUUID(),
          toolName: 'edit',
          command: 'edit path=src/example.ts edits=1',
          reviewPayload: '{\n  "path": "src/example.ts"\n}',
        }),
      );
      return process.pid;
    }
    this.store.transition(runId, running.revision, {
      runId,
      revision: running.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'failed',
      pid: process.pid,
      error: 'fixture launch failed',
    });
    throw new Error('fixture launch failed');
  }
}

let healthServer: HealthServer;
let oldStatusUrl: string | undefined;
let oldConfigUrl: string | undefined;

before(async () => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
  healthServer = new HealthServer();
  await healthServer.start();
  oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL =
    `http://127.0.0.1:${healthServer.getPort()}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL =
    `http://127.0.0.1:${healthServer.getPort()}/config`;
});

after(async () => {
  if (oldStatusUrl === undefined) {
    delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  } else {
    process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
  }
  if (oldConfigUrl === undefined) {
    delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  } else {
    process.env.SIFTKIT_CONFIG_SERVICE_URL = oldConfigUrl;
  }
  await healthServer.close();
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeHarness(mode: FixtureLaunchMode): CommandHarness {
  const runsRoot = join(TEMP_ROOT, randomUUID());
  mkdirSync(runsRoot);
  const store = new SettlingRunStore(runsRoot);
  const launcher = new FixtureLauncher(mode, store);
  return {
    command: new RepoAgentCommand({
      store,
      launcher,
      repoRoot: process.cwd(),
    }),
    launcher,
    store,
  };
}

function makeStreams(isTty = false): CapturedStreams {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const stdin = Object.assign(new PassThrough(), { isTTY: isTty });
  return {
    streams: {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
    },
    stdout,
    stderr,
  };
}

function parseSingleResult(stdout: CaptureStream) {
  const text = stdout.read();
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.trim().split('\n').length, 1);
  return RepoAgentRunResultSchema.parse(parseJsonValueText(text));
}

function createApprovalState(store: RepoAgentRunStore): RepoAgentWorkerRequest {
  const request: RepoAgentWorkerRequest = {
    runId: randomUUID(),
    task: 'existing task',
    repoRoot: process.cwd(),
    approval: 'auto',
    progress: false,
    images: [],
  };
  store.create(request);
  const running = store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: process.pid,
  });
  store.publishApproval(
    request.runId,
    running.revision,
    RepoAgentApprovalSchema.parse({
      approvalId: randomUUID(),
      toolName: 'run',
      command: 'npm test',
      reviewPayload: '{"command":"npm test"}',
    }),
  );
  return request;
}

test('non-TTY start launches once and emits one completed JSON object', async () => {
  const harness = makeHarness('completed');
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation([
      'implement it',
      '--model',
      'test-model',
      '--log-file',
      'agent.log',
    ]),
    capture.streams,
  );

  assert.equal(code, 0);
  const result = parseSingleResult(capture.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'fixture completed');
  assert.deepEqual(harness.launcher.launchedRunIds, [result.runId]);
  assert.deepEqual(harness.store.readRequest(result.runId), {
    runId: result.runId,
    task: 'implement it',
    repoRoot: process.cwd(),
    model: 'test-model',
    logFile: 'agent.log',
    approval: 'auto',
    progress: false,
    images: [],
  });
  assert.equal(capture.stderr.read(), '');
});

test('non-TTY start emits the complete approval boundary', async () => {
  const harness = makeHarness('approval');
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation(['edit the file']),
    capture.streams,
  );

  assert.equal(code, 0);
  const result = parseSingleResult(capture.stdout);
  assert.equal(result.status, 'approval_required');
  assert.deepEqual(result.approval, {
    approvalId: result.approval.approvalId,
    toolName: 'edit',
    command: 'edit path=src/example.ts edits=1',
    reviewPayload: '{\n  "path": "src/example.ts"\n}',
  });
});

test('launch failure emits one failed object and returns non-zero', async () => {
  const harness = makeHarness('failed');
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation(['fail safely']),
    capture.streams,
  );

  assert.equal(code, 1);
  const result = parseSingleResult(capture.stdout);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'fixture launch failed');
});

test('status returns current state without mutation', async () => {
  const harness = makeHarness('completed');
  const request: RepoAgentWorkerRequest = {
    runId: randomUUID(),
    task: 'status task',
    repoRoot: process.cwd(),
    approval: 'auto',
    progress: false,
    images: [],
  };
  harness.store.create(request);
  const before = harness.store.readState(request.runId);
  const filesBefore = readdirSync(join(harness.store.getRunsRoot(), request.runId));
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation(['status', request.runId]),
    capture.streams,
  );

  assert.equal(code, 0);
  assert.deepEqual(parseJsonValueText(capture.stdout.read()), before);
  assert.deepEqual(harness.store.readState(request.runId), before);
  assert.deepEqual(
    readdirSync(join(harness.store.getRunsRoot(), request.runId)),
    filesBefore,
  );
});

test('unknown status fails without creating a run directory', async () => {
  const harness = makeHarness('completed');
  const unknownRunId = randomUUID();
  const capture = makeStreams();
  await assert.rejects(
    () => harness.command.run(
      parseRepoAgentInvocation(['status', unknownRunId]),
      capture.streams,
    ),
    /not found/iu,
  );
  assert.deepEqual(readdirSync(harness.store.getRunsRoot()), []);
});

test('decide approve submits once and waits for completion', async () => {
  const harness = makeHarness('completed');
  const request = createApprovalState(harness.store);
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation(['decide', request.runId, 'approve']),
    capture.streams,
  );

  assert.equal(code, 0);
  assert.equal(harness.store.submittedDecisions.length, 1);
  assert.equal(harness.store.submittedDecisions[0]?.decision, 'approve');
  const result = parseSingleResult(capture.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.runId, request.runId);
});

test('decide deny preserves the reason and returns completion', async () => {
  const harness = makeHarness('completed');
  const request = createApprovalState(harness.store);
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation([
      'decide',
      request.runId,
      'deny',
      '--reason',
      'unsafe path',
    ]),
    capture.streams,
  );

  assert.equal(code, 0);
  assert.deepEqual(harness.store.submittedDecisions[0], {
    runId: request.runId,
    approvalId: harness.store.submittedDecisions[0]?.approvalId,
    observedRevision: 2,
    decision: 'deny',
    reason: 'unsafe path',
  });
  const result = parseSingleResult(capture.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'denied: unsafe path');
});

test('decide abort returns aborted and non-zero', async () => {
  const harness = makeHarness('completed');
  const request = createApprovalState(harness.store);
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation(['decide', request.runId, 'abort']),
    capture.streams,
  );

  assert.equal(code, 1);
  const result = parseSingleResult(capture.stdout);
  assert.deepEqual(result, {
    status: 'aborted',
    runId: request.runId,
  });
});

test('a repeated decision fails closed', async () => {
  const harness = makeHarness('completed');
  const request = createApprovalState(harness.store);
  const first = makeStreams();
  await harness.command.run(
    parseRepoAgentInvocation(['decide', request.runId, 'approve']),
    first.streams,
  );

  const repeated = makeStreams();
  await assert.rejects(
    () => harness.command.run(
      parseRepoAgentInvocation(['decide', request.runId, 'approve']),
      repeated.streams,
    ),
    /no pending approval/iu,
  );
  assert.equal(harness.store.submittedDecisions.length, 1);
});
