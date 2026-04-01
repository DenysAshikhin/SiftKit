const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Writable } = require('node:stream');

const { runCli } = require('../dist/cli.js');

function makeCaptureStream() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    read() {
      return text;
    },
  };
}

test('repo-search delegates execution to status server', async () => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        received.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          requestId: 'req-1',
          transcriptPath: 'C:\\tmp\\repo-search.jsonl',
          artifactPath: 'C:\\tmp\\repo-search.json',
          scorecard: {
            runId: 'run-1',
            model: 'mock-model',
            tasks: [
              {
                id: 'repo-search',
                finalOutput: 'Found planner tools in src/summary.ts',
              },
            ],
            totals: {
              tasks: 1,
              passed: 1,
              failed: 0,
              commandsExecuted: 2,
              safetyRejects: 0,
              invalidResponses: 0,
            },
            verdict: 'pass',
            failureReasons: [],
          },
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = Number(address.port);
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;

  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['repo-search', '--prompt', 'find planner tools'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].prompt, 'find planner tools');
    assert.equal(received[0].repoRoot, process.cwd());
    assert.equal(stdout.read(), 'Found planner tools in src/summary.ts\n');
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
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
