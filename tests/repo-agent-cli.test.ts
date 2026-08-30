import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, before } from 'node:test';
import { runCli } from '../src/cli/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import {
  buildRepoAgentDecideCommands,
  RepoAgentRunResultSchema,
} from '../src/repo-agent/run-schemas.js';
import { makeCaptureStream, readBody } from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';

const TEMP_ROOT = join(tmpdir(), `siftkit-repo-agent-cli-tests-${process.pid}`);
const BIN_PATH = join(process.cwd(), 'dist', 'cli', 'main.js');

type ServerMode = 'approval' | 'complete';

type CliProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

class RepoAgentTestServer {
  readonly runId = randomUUID();
  readonly approvalId = randomUUID();
  readonly startRequests: JsonObject[] = [];
  readonly decideRequests: JsonObject[] = [];
  readonly approvalRequests: JsonObject[] = [];

  private readonly server: http.Server;
  private interactiveResponse: http.ServerResponse | null = null;

  constructor(private readonly mode: ServerMode) {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${getAddressInfo(this.server).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      this.writeJson(response, { ok: true });
      return;
    }
    if (request.method === 'POST' && request.url === '/repo-agent') {
      const startRequest = asObject(parseJsonValueText(await readBody(request)));
      this.startRequests.push(startRequest);
      this.openSse(response);
      if (startRequest.approval === 'interactive') {
        this.interactiveResponse = response;
        this.writeEvent(response, 'progress', {
          kind: 'approval_request',
          requestId: 'request-interactive',
          approvalId: this.approvalId,
          turn: 1,
          maxTurns: 4,
          toolName: 'write',
          command: 'write path="interactive.txt"',
          reviewPayload: '{"path":"interactive.txt"}',
        });
        return;
      }
      if (this.mode === 'approval') {
        this.writeEvent(response, 'progress', {
          kind: 'llm_start', turn: 1, maxTurns: 4, promptTokenCount: 100, thinkingTokenCount: 25, elapsedMs: 1_000,
        });
        this.writeEvent(response, 'progress', {
          kind: 'tool_start', turn: 1, maxTurns: 4, command: 'npm install left-pad',
        });
        this.writeEvent(response, 'result', {
          status: 'approval_required',
          runId: this.runId,
          approval: {
            approvalId: this.approvalId,
            toolName: 'run',
            command: 'npm install left-pad',
            reviewPayload: null,
          },
          decide: buildRepoAgentDecideCommands(this.runId),
        });
      } else {
        this.writeEvent(response, 'result', {
          status: 'completed', runId: this.runId, output: 'foreground complete',
        });
      }
      response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/repo-search/approval') {
      this.approvalRequests.push(asObject(parseJsonValueText(await readBody(request))));
      this.writeJson(response, { accepted: true });
      const operationResponse = this.interactiveResponse;
      if (!operationResponse) {
        throw new Error('Missing interactive repo-agent response.');
      }
      this.writeEvent(operationResponse, 'result', {
        status: 'completed', runId: this.runId, output: 'interactive complete',
      });
      operationResponse.end();
      this.interactiveResponse = null;
      return;
    }
    if (request.method === 'POST' && request.url === '/repo-agent/decide') {
      this.decideRequests.push(asObject(parseJsonValueText(await readBody(request))));
      this.openSse(response);
      this.writeEvent(response, 'result', {
        status: 'completed', runId: this.runId, output: 'resumed and finished',
      });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  }

  private openSse(response: http.ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('\n');
  }

  private writeEvent(response: http.ServerResponse, event: string, body: JsonObject): void {
    response.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
  }

  private writeJson(response: http.ServerResponse, body: JsonObject): void {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}

class CliProcessRunner {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  run(args: string[]): Promise<CliProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN_PATH, ...args], {
        cwd: TEMP_ROOT,
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
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

function makeRunner(server: RepoAgentTestServer): CliProcessRunner {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SIFTKIT_STATUS_BACKEND_URL: `${server.getBaseUrl()}/status`,
    SIFTKIT_CONFIG_SERVICE_URL: `${server.getBaseUrl()}/config`,
  };
  delete environment.SIFTKIT_AGENT_RUN_ID;
  return new CliProcessRunner(environment);
}

test('non-TTY start with --progress prints progress to stderr and a complete approval boundary to stdout', async () => {
  const server = new RepoAgentTestServer('approval');
  await server.start();
  try {
    const result = await makeRunner(server).run(['repo-agent', 'edit the file', '--progress']);

    assert.equal(result.code, 3, result.stderr);
    const boundary = RepoAgentRunResultSchema.parse(parseJsonValueText(result.stdout));
    assert.equal(boundary.status, 'approval_required');
    assert.match(result.stderr, /Exiting: approval required/u);
    assert.match(result.stderr, /llm_start prompt=100tok {2}thinking-total=25$/mu);
    assert.match(result.stderr, /npm install left-pad/u);
  } finally {
    await server.close();
  }
});

test('non-TTY start without --progress prints the approval banner but no per-turn progress', async () => {
  const server = new RepoAgentTestServer('approval');
  await server.start();
  try {
    const result = await makeRunner(server).run(['repo-agent', 'edit the file']);

    assert.equal(result.code, 3, result.stderr);
    assert.equal(RepoAgentRunResultSchema.parse(parseJsonValueText(result.stdout)).status, 'approval_required');
    assert.match(result.stderr, /Exiting: approval required/u);
    assert.equal(result.stderr.includes('llm_start'), false);
    assert.doesNotMatch(result.stderr, /repo-agent t1\/4 npm install left-pad/u);
  } finally {
    await server.close();
  }
});

test('non-TTY completed start exits zero with one parseable result object', async () => {
  const server = new RepoAgentTestServer('complete');
  await server.start();
  try {
    const result = await makeRunner(server).run(['repo-agent', 'finish the task']);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(RepoAgentRunResultSchema.parse(parseJsonValueText(result.stdout)), {
      status: 'completed', runId: server.runId, output: 'foreground complete',
    });
    assert.equal(result.stdout.trim().split('\n').length, 1);
  } finally {
    await server.close();
  }
});

test('decide posts the decision and streams to the next completed boundary', async () => {
  const server = new RepoAgentTestServer('complete');
  await server.start();
  try {
    const result = await makeRunner(server).run([
      'repo-agent', 'decide', server.runId, 'approve', '--progress',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(RepoAgentRunResultSchema.parse(parseJsonValueText(result.stdout)), {
      status: 'completed', runId: server.runId, output: 'resumed and finished',
    });
    assert.deepEqual(server.decideRequests, [{ runId: server.runId, decision: 'approve' }]);
  } finally {
    await server.close();
  }
});

test('TTY interactive start prompts, submits approval, and receives the completed boundary', async () => {
  const server = new RepoAgentTestServer('complete');
  await server.start();
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${server.getBaseUrl()}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `${server.getBaseUrl()}/config`;
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const answerTimer = setTimeout(() => stdin.write('a\n'), 50);
  try {
    const code = await runCli({
      argv: ['repo-agent', 'edit interactively', '--approval', 'interactive'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin,
    });

    assert.equal(code, 0);
    assert.deepEqual(RepoAgentRunResultSchema.parse(parseJsonValueText(stdout.read())), {
      status: 'completed', runId: server.runId, output: 'interactive complete',
    });
    assert.match(stderr.read(), /wants to run: write path="interactive\.txt"/u);
    assert.deepEqual(server.approvalRequests, [{
      requestId: 'request-interactive',
      approvalId: server.approvalId,
      decision: 'approve',
    }]);
  } finally {
    clearTimeout(answerTimer);
    stdin.end();
    if (oldStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
    if (oldConfigUrl === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    else process.env.SIFTKIT_CONFIG_SERVICE_URL = oldConfigUrl;
    await server.close();
  }
});
test('split task tokens warn with the joined prompt while one task token stays silent', async () => {
  const server = new RepoAgentTestServer('complete');
  await server.start();
  try {
    const runner = makeRunner(server);
    const split = await runner.run(['repo-agent', 'Implement ONLY Task', '1:', 'add widget']);
    const single = await runner.run(['repo-agent', 'single task']);

    assert.equal(split.code, 0, split.stderr);
    assert.match(split.stderr, /joined 3 command-line tokens into one task/u);
    assert.match(split.stderr, /task: Implement ONLY Task 1: add widget/u);
    assert.equal(single.code, 0, single.stderr);
    assert.equal(single.stderr, '');
    assert.equal(server.startRequests[0]?.prompt, 'Implement ONLY Task 1: add widget');
    assert.equal(server.startRequests[1]?.prompt, 'single task');
  } finally {
    await server.close();
  }
});
