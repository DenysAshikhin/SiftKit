import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, before } from 'node:test';

import { parseRepoAgentInvocation } from '../src/cli/repo-agent-args.js';
import {
  RepoAgentCommand,
  type RepoAgentApi,
  type RepoAgentCommandStreams,
} from '../src/cli/repo-agent-command.js';
import type { RepoAgentDecideRequest } from '../src/repo-agent/api-schemas.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import {
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from '../src/repo-agent/run-schemas.js';
import { makeCaptureStream, type CaptureStream } from './_test-helpers.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

const RUN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEMP_ROOT = join(process.cwd(), '.tmp', `repo-agent-command-tests-${process.pid}`);

class HealthServer {
  private readonly server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  getPort(): number {
    return getAddressInfo(this.server).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

class FakeApi implements RepoAgentApi {
  readonly startCalls: Record<string, JsonSerializable>[] = [];
  readonly decideCalls: RepoAgentDecideRequest[] = [];
  readonly statusCalls: string[] = [];

  constructor(
    private readonly result: RepoAgentRunResult,
    private readonly state: RepoAgentRunState = {
      runId: RUN_ID,
      revision: 0,
      updatedAtUtc: '2026-08-08T12:00:00.000Z',
      status: 'starting',
      pid: process.pid,
    },
    private readonly statusFailure: Error | undefined = undefined,
  ) {}

  requestRepoAgent(request: Record<string, JsonSerializable>): Promise<RepoAgentRunResult> {
    this.startCalls.push(request);
    return Promise.resolve(this.result);
  }

  requestRepoAgentDecide(request: RepoAgentDecideRequest): Promise<RepoAgentRunResult> {
    this.decideCalls.push(request);
    return Promise.resolve(this.result);
  }

  requestRepoAgentStatus(runId: string): Promise<RepoAgentRunState> {
    this.statusCalls.push(runId);
    if (this.statusFailure) {
      return Promise.reject(this.statusFailure);
    }
    return Promise.resolve(this.state);
  }
}

type CapturedStreams = {
  streams: RepoAgentCommandStreams;
  stdout: CaptureStream;
  stderr: CaptureStream;
};

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
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${healthServer.getPort()}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${healthServer.getPort()}/config`;
});

after(async () => {
  if (oldStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  else process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
  if (oldConfigUrl === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  else process.env.SIFTKIT_CONFIG_SERVICE_URL = oldConfigUrl;
  await healthServer.close();
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeStreams(isTty = false): CapturedStreams {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const stdin = Object.assign(new PassThrough(), { isTTY: isTty });
  return {
    streams: { stdin, stdout: stdout.stream, stderr: stderr.stream },
    stdout,
    stderr,
  };
}

function makeCommand(
  result: RepoAgentRunResult,
  state?: RepoAgentRunState,
  statusFailure?: Error,
): { command: RepoAgentCommand; api: FakeApi } {
  const api = new FakeApi(result, state, statusFailure);
  return { command: new RepoAgentCommand({ api }), api };
}

function parseSingleResult(stdout: CaptureStream): RepoAgentRunResult {
  const text = stdout.read();
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.trim().split('\n').length, 1);
  return RepoAgentRunResultSchema.parse(parseJsonValueText(text));
}

test('start completed prints one result object and exits zero', async () => {
  const harness = makeCommand({ status: 'completed', runId: RUN_ID, output: 'foreground complete' });
  const capture = makeStreams();

  const code = await harness.command.run(
    parseRepoAgentInvocation(['implement it', '--model', 'test-model']),
    capture.streams,
  );

  assert.equal(code, 0);
  assert.deepEqual(parseSingleResult(capture.stdout), {
    status: 'completed', runId: RUN_ID, output: 'foreground complete',
  });
  assert.deepEqual(harness.api.startCalls, [{
    prompt: 'implement it', repoRoot: process.cwd(), approval: 'auto', model: 'test-model',
  }]);
  assert.equal(capture.stderr.read(), '');
});

test('start approval_required prints the resume banner and exits three', async () => {
  const result: RepoAgentRunResult = {
    status: 'approval_required',
    runId: RUN_ID,
    approval: {
      approvalId: '37d0379d-11af-4e15-bfaa-63ffea17b896',
      toolName: 'run',
      command: 'npm test',
      reviewPayload: null,
    },
    decide: {
      approve: `siftkit repo-agent decide ${RUN_ID} approve`,
      deny: `siftkit repo-agent decide ${RUN_ID} deny --reason "<why>"`,
      abort: `siftkit repo-agent decide ${RUN_ID} abort`,
    },
  };
  const harness = makeCommand(result);
  const capture = makeStreams();

  const code = await harness.command.run(parseRepoAgentInvocation(['implement it']), capture.streams);

  assert.equal(code, 3);
  assert.deepEqual(parseSingleResult(capture.stdout), result);
  const stderr = capture.stderr.read();
  assert.match(stderr, /Exiting: approval required/u);
  assert.equal(stderr.includes(result.decide.approve), true);
  assert.equal(stderr.includes(result.decide.deny), true);
  assert.equal(stderr.includes(result.decide.abort), true);
});

test('decide sends the server request and prints the next boundary', async () => {
  const harness = makeCommand({ status: 'completed', runId: RUN_ID, output: 'resumed and finished' });
  const capture = makeStreams();

  const code = await harness.command.run(
    parseRepoAgentInvocation(['decide', RUN_ID, 'approve', '--progress']),
    capture.streams,
  );

  assert.equal(code, 0);
  assert.deepEqual(harness.api.decideCalls, [{ runId: RUN_ID, decision: 'approve' }]);
  assert.equal(parseSingleResult(capture.stdout).status, 'completed');
});

test('deny sends its required reason to the server', async () => {
  const harness = makeCommand({ status: 'completed', runId: RUN_ID, output: 'denied and finished' });
  const capture = makeStreams();

  const code = await harness.command.run(
    parseRepoAgentInvocation(['decide', RUN_ID, 'deny', '--reason', 'unsafe path']),
    capture.streams,
  );

  assert.equal(code, 0);
  assert.deepEqual(harness.api.decideCalls, [{
    runId: RUN_ID, decision: 'deny', reason: 'unsafe path',
  }]);
});

test('abort prints an aborted result and exits non-zero', async () => {
  const harness = makeCommand({ status: 'aborted', runId: RUN_ID });
  const capture = makeStreams();

  const code = await harness.command.run(
    parseRepoAgentInvocation(['decide', RUN_ID, 'abort']),
    capture.streams,
  );

  assert.equal(code, 1);
  assert.deepEqual(parseSingleResult(capture.stdout), { status: 'aborted', runId: RUN_ID });
});

test('status requests the server state without constructing a local store', async () => {
  const state = RepoAgentRunStateSchema.parse({
    runId: RUN_ID,
    revision: 1,
    updatedAtUtc: '2026-08-08T12:00:00.000Z',
    status: 'failed',
    error: 'server-owned failure',
  });
  const harness = makeCommand({ status: 'completed', runId: RUN_ID, output: 'unused' }, state);
  const capture = makeStreams();

  const code = await harness.command.run(parseRepoAgentInvocation(['status', RUN_ID]), capture.streams);

  assert.equal(code, 0);
  assert.deepEqual(RepoAgentRunStateSchema.parse(parseJsonValueText(capture.stdout.read())), state);
  assert.deepEqual(harness.api.statusCalls, [RUN_ID]);
  assert.equal(harness.api.startCalls.length, 0);
  assert.equal(harness.api.decideCalls.length, 0);
});

test('unknown status fails without creating a run directory', async () => {
  const harness = makeCommand(
    { status: 'completed', runId: RUN_ID, output: 'unused' },
    undefined,
    new Error('Unknown repo-agent run'),
  );
  const capture = makeStreams();

  await assert.rejects(
    () => harness.command.run(parseRepoAgentInvocation(['status', RUN_ID]), capture.streams),
    /not found|unknown/iu,
  );
});

test('interactive approval rejects non-TTY stdin before starting', async () => {
  const harness = makeCommand({ status: 'completed', runId: RUN_ID, output: 'unused' });
  const capture = makeStreams(false);

  await assert.rejects(
    () => harness.command.run(
      parseRepoAgentInvocation(['implement it', '--approval', 'interactive']),
      capture.streams,
    ),
    /requires a TTY/u,
  );
  assert.equal(harness.api.startCalls.length, 0);
});
