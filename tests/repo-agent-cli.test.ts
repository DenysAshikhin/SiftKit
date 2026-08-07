import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, before } from 'node:test';

import { runCli } from '../src/cli/index.js';
import { getRuntimeRoot } from '../src/config/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import {
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
} from '../src/repo-agent/run-schemas.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import {
  buildMockScorecard,
  makeCaptureStream,
  readBody,
} from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { writeSseResult } from './helpers/sse-http.js';

const TEMP_ROOT = join(
  tmpdir(),
  `siftkit-repo-agent-cli-tests-${process.pid}`,
);
const BIN_PATH = join(process.cwd(), 'bin', 'siftkit.js');

type ServerMode = 'approval' | 'complete';

type CliProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function makeResult(finalOutput: string): RepoSearchExecutionResult {
  return {
    requestId: 'request-1',
    transcriptPath: join(TEMP_ROOT, 'transcript.jsonl'),
    artifactPath: join(TEMP_ROOT, 'artifact.json'),
    scorecard: buildMockScorecard(finalOutput),
  };
}

class RepoAgentTestServer {
  readonly approvalId = randomUUID();
  readonly approvals: JsonObject[] = [];
  readonly requests: JsonObject[] = [];
  healthHits = 0;

  private readonly mode: ServerMode;
  private readonly server: http.Server;
  private operationResponse: http.ServerResponse | undefined;

  constructor(mode: ServerMode) {
    this.mode = mode;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${getAddressInfo(this.server).port}`;
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

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      this.healthHits += 1;
      this.writeJson(response, { ok: true });
      return;
    }
    if (request.method === 'POST' && request.url === '/repo-agent') {
      this.requests.push(asObject(parseJsonValueText(await readBody(request))));
      if (this.mode === 'complete') {
        writeSseResult(response, makeResult('foreground complete'));
        return;
      }
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
        toolName: 'edit',
        command: 'edit path=src/example.ts edits=1',
        reviewPayload: '{"path":"src/example.ts","content":"safe"}',
      })}\n\n`);
      return;
    }
    if (
      request.method === 'POST'
      && request.url === '/repo-search/approval'
    ) {
      this.approvals.push(
        asObject(parseJsonValueText(await readBody(request))),
      );
      this.writeJson(response, { accepted: true });
      if (!this.operationResponse) {
        throw new Error('Missing pending repo-agent response.');
      }
      this.operationResponse.write(
        `event: result\ndata: ${JSON.stringify(makeResult('resumed complete'))}\n\n`,
      );
      this.operationResponse.end();
      return;
    }
    response.writeHead(404);
    response.end();
  }

  private writeJson(
    response: http.ServerResponse,
    body: JsonObject,
  ): void {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}

class CliProcessRunner {
  private readonly cwd: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(cwd: string, environment: NodeJS.ProcessEnv) {
    this.cwd = cwd;
    this.environment = environment;
  }

  run(args: string[]): Promise<CliProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN_PATH, ...args], {
        cwd: this.cwd,
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }
}

before(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function readRunEntries(): string[] {
  const runsRoot = join(getRuntimeRoot(), 'repo-agent', 'runs');
  return existsSync(runsRoot) ? readdirSync(runsRoot).sort() : [];
}

test('TTY explicit off stays foreground and creates no resumable run', async () => {
  const server = new RepoAgentTestServer('complete');
  await server.start();
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${server.getBaseUrl()}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `${server.getBaseUrl()}/config`;
  const entriesBefore = readRunEntries();
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const code = await runCli({
      argv: ['repo-agent', 'make x', '--approval', 'off'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'foreground complete\n');
    assert.deepEqual(server.requests, [{
      prompt: 'make x',
      repoRoot: process.cwd(),
      approval: 'off',
    }]);
    assert.deepEqual(readRunEntries(), entriesBefore);
  } finally {
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
    await server.close();
  }
});

test('TTY escalation uses the human prompter without creating resumable state', async () => {
  const server = new RepoAgentTestServer('approval');
  await server.start();
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${server.getBaseUrl()}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `${server.getBaseUrl()}/config`;
  const entriesBefore = readRunEntries();
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    setTimeout(() => stdin.write('a\n'), 100);
    const code = await runCli({
      argv: ['repo-agent', 'edit the file'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'resumed complete\n');
    assert.match(stderr.read(), /wants to run.*edit path=src\/example\.ts/isu);
    assert.deepEqual(server.approvals, [{
      requestId: 'request-1',
      approvalId: server.approvalId,
      decision: 'approve',
    }]);
    assert.deepEqual(readRunEntries(), entriesBefore);
  } finally {
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
    await server.close();
  }
});

test('non-TTY start and decide resume one real detached worker', async () => {
  const server = new RepoAgentTestServer('approval');
  await server.start();
  const baseUrl = server.getBaseUrl();
  const runner = new CliProcessRunner(TEMP_ROOT, {
    ...process.env,
    SIFTKIT_STATUS_BACKEND_URL: `${baseUrl}/status`,
    SIFTKIT_CONFIG_SERVICE_URL: `${baseUrl}/config`,
  });
  try {
    const started = await runner.run(['repo-agent', 'edit the file']);
    assert.equal(started.code, 3, started.stderr);
    assert.doesNotMatch(started.stdout, /\u001b\[/u);
    const approval = RepoAgentRunResultSchema.parse(
      parseJsonValueText(started.stdout),
    );
    assert.equal(approval.status, 'approval_required');
    assert.ok(approval.status === 'approval_required');
    assert.deepEqual(approval.decide, {
      approve: `siftkit repo-agent decide ${approval.runId} approve`,
      deny: `siftkit repo-agent decide ${approval.runId} deny --reason "<why>"`,
      abort: `siftkit repo-agent decide ${approval.runId} abort`,
    });
    assert.equal(approval.approval.reviewPayload, '{"path":"src/example.ts","content":"safe"}');

    const statePath = join(
      TEMP_ROOT,
      '.siftkit',
      'repo-agent',
      'runs',
      approval.runId,
      'state.json',
    );
    const pendingState = RepoAgentRunStateSchema.parse(
      parseJsonValueText(readFileSync(statePath, 'utf8')),
    );
    assert.equal(pendingState.status, 'approval_required');

    const decided = await runner.run([
      'repo-agent',
      'decide',
      approval.runId,
      'approve',
    ]);
    assert.equal(decided.code, 0, decided.stderr);
    const completed = RepoAgentRunResultSchema.parse(
      parseJsonValueText(decided.stdout),
    );
    assert.deepEqual(completed, {
      status: 'completed',
      runId: approval.runId,
      output: 'resumed complete',
    });
    const completedState = RepoAgentRunStateSchema.parse(
      parseJsonValueText(readFileSync(statePath, 'utf8')),
    );
    assert.equal(completedState.status, 'completed');
    assert.equal(completedState.pid, pendingState.pid);
    assert.deepEqual(server.approvals, [{
      requestId: 'request-1',
      approvalId: server.approvalId,
      decision: 'approve',
    }]);

    const healthHits = server.healthHits;
    const status = await runner.run([
      'repo-agent',
      'status',
      approval.runId,
    ]);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(parseJsonValueText(status.stdout), completedState);
    assert.equal(server.healthHits, healthHits);
  } finally {
    await server.close();
  }
});

test('invalid legacy syntax fails before contacting the server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', '--prompt', 'make x'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: new PassThrough(),
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /--prompt is not supported/iu);
  assert.equal(stdout.read(), '');
});
