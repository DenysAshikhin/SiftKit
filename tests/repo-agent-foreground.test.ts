import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import test, { after, before } from 'node:test';

import { RepoAgentStartInvocationSchema } from '../src/cli/repo-agent-args.js';
import { runRepoAgentForegroundCli } from '../src/cli/run-repo-agent-foreground.js';
import type { JsonObject } from '../src/lib/json-types.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import {
  buildMockScorecard,
  makeCaptureStream,
} from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { writeSseResult } from './helpers/sse-http.js';

class ForegroundServer {
  readonly requests: JsonObject[] = [];

  private readonly server: http.Server;

  constructor() {
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
    });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/repo-agent') {
      response.writeHead(404);
      response.end();
      return;
    }
    this.requests.push(asObject(JSON.parse(await this.readBody(request))));
    const result: RepoSearchExecutionResult = {
      requestId: 'foreground-request',
      transcriptPath: '/tmp/transcript.jsonl',
      artifactPath: '/tmp/artifact.json',
      scorecard: buildMockScorecard('typed foreground complete'),
    };
    writeSseResult(response, result);
  }

  private readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => resolve(body));
    });
  }
}

let server: ForegroundServer;
let oldStatusUrl: string | undefined;

before(async () => {
  server = new ForegroundServer();
  await server.start();
  oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL =
    `http://127.0.0.1:${server.getPort()}/status`;
});

after(async () => {
  if (oldStatusUrl === undefined) {
    delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  } else {
    process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
  }
  await server.close();
});

test('runs a typed repo-agent invocation without reconstructing argv', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const invocation = RepoAgentStartInvocationSchema.parse({
    kind: 'start',
    task: 'typed foreground task',
    model: 'typed-model',
    logFile: 'typed.log',
    approval: 'auto',
    progress: false,
  });

  const code = await runRepoAgentForegroundCli({
    invocation,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(code, 0);
  assert.equal(stdout.read(), 'typed foreground complete\n');
  assert.equal(stderr.read(), '');
  assert.deepEqual(server.requests, [{
    prompt: 'typed foreground task',
    repoRoot: process.cwd(),
    model: 'typed-model',
    logFile: 'typed.log',
    approval: 'auto',
  }]);
});

test('typed foreground approval requires a TTY', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const stdin = Object.assign(new PassThrough(), { isTTY: false });

  await assert.rejects(
    () => runRepoAgentForegroundCli({
      invocation: RepoAgentStartInvocationSchema.parse({
        kind: 'start',
        task: 'typed foreground task',
        approval: 'auto',
        progress: false,
      }),
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
    }),
    /requires a TTY/iu,
  );
  assert.equal(server.requests.length, 1);
});
