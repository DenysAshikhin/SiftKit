import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { runCli } from '../src/cli/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { buildMockScorecard, makeCaptureStream } from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';

function makeTtyInput(): PassThrough & { isTTY: boolean } {
  return Object.assign(new PassThrough(), { isTTY: true });
}

test('interactive CLI prompts on approval_request and POSTs the decision', async () => {
  const decisions: JsonObject[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/repo-search') {
        const parsed = asObject(parseJsonValueText(body || '{}'));
        assert.equal(parsed.interactive, true);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('\n');
        res.write(`event: progress\ndata: ${JSON.stringify({
          kind: 'approval_request', requestId: 'req-1', approvalId: 'ap-1',
          turn: 1, maxTurns: 4, toolName: 'write', command: 'write path=out.txt',
        })}\n\n`);
        const finish = setInterval(() => {
          if (decisions.length === 0) return;
          clearInterval(finish);
          const result: RepoSearchExecutionResult = {
            requestId: 'req-1',
            transcriptPath: 'C:\\tmp\\t.jsonl',
            artifactPath: 'C:\\tmp\\a.json',
            scorecard: buildMockScorecard('interactive done'),
          };
          res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
          res.end();
        }, 20);
        return;
      }
      if (req.url === '/repo-search/approval') {
        decisions.push(asObject(parseJsonValueText(body || '{}')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = getAddressInfo(server).port;
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const stdin = makeTtyInput();
    setTimeout(() => stdin.write('a\n'), 150);
    const code = await runCli({
      argv: ['repo-search', '--prompt', 'write something', '--interactive'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin,
    });
    assert.equal(code, 0);
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0], { requestId: 'req-1', approvalId: 'ap-1', decision: 'approve' });
    assert.match(stderr.read(), /wants to run: write path=out\.txt/u);
    assert.equal(stdout.read(), 'interactive done\n');
  } finally {
    if (oldStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('--interactive without a TTY fails fast', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '--prompt', 'x', '--interactive'],
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: new PassThrough(), // no isTTY
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /--interactive requires a TTY/u);
});
