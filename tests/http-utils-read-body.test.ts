import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  RequestBodyTooLargeError,
  readBody,
} from '../src/status-server/http-utils.js';
import { testHttpAgent } from './helpers/http-agent.js';

type ReadOutcome = { ok: true; text: string } | { ok: false; error: Error };

async function startBodyServer(
  onOutcome: (outcome: ReadOutcome) => void,
  maxBytes?: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    readBody(req, maxBytes === undefined ? undefined : { maxBytes })
      .then((text) => {
        onOutcome({ ok: true, text });
        res.writeHead(200).end('ok');
      })
      .catch((error: Error) => {
        onOutcome({ ok: false, error });
        if (!res.writableEnded) {
          res.writeHead(500).end('err');
        }
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('readBody resolves normally for a complete body', async () => {
  const outcomes: ReadOutcome[] = [];
  const server = await startBodyServer((outcome) => outcomes.push(outcome));
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: server.port, method: 'POST', path: '/', agent: testHttpAgent },
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        },
      );
      request.on('error', reject);
      request.end('{"a":1}');
    });
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0], { ok: true, text: '{"a":1}' });
  } finally {
    await server.close();
  }
});

test('readBody settles with an error when the client aborts mid-body', async () => {
  const outcomes: ReadOutcome[] = [];
  const server = await startBodyServer((outcome) => outcomes.push(outcome));
  try {
    const request = http.request({
      host: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: '/',
      agent: testHttpAgent,
      headers: { 'Content-Length': '1000' },
    });
    request.on('error', () => {});
    request.write('partial');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    request.destroy();

    for (let attempt = 0; attempt < 100 && outcomes.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(outcomes.length, 1, 'readBody must settle instead of hanging forever');
    assert.equal(outcomes[0]?.ok, false);
  } finally {
    await server.close();
  }
});

test('readBody rejects with RequestBodyTooLargeError past the cap', async () => {
  const outcomes: ReadOutcome[] = [];
  const server = await startBodyServer((outcome) => outcomes.push(outcome), 64);
  try {
    await new Promise<void>((resolve) => {
      const request = http.request(
        { host: '127.0.0.1', port: server.port, method: 'POST', path: '/', agent: testHttpAgent },
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        },
      );
      request.on('error', () => resolve());
      request.end('x'.repeat(512));
    });

    for (let attempt = 0; attempt < 100 && outcomes.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.ok, false);
    assert.ok(
      outcomes[0]?.ok === false && outcomes[0].error instanceof RequestBodyTooLargeError,
      'oversize bodies must reject with RequestBodyTooLargeError',
    );
  } finally {
    await server.close();
  }
});
