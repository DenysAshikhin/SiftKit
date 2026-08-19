import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import {
  RequestBodyTooLargeError,
  readBodyToFile,
} from '../src/status-server/http-utils.js';
import { testHttpAgent } from './helpers/http-agent.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

type WriteOutcome = { ok: true } | { ok: false; error: Error };

interface BodyServer {
  readonly port: number;
  readonly destinationPath: string;
  readonly outcomes: WriteOutcome[];
  close(): Promise<void>;
}

async function startBodyServer(prefix: string, maxBytes: number): Promise<BodyServer> {
  const destinationPath = path.join(createManagedTempDir(prefix), 'upload.bin');
  const outcomes: WriteOutcome[] = [];
  const server = http.createServer((req, res) => {
    readBodyToFile(req, destinationPath, { maxBytes })
      .then(() => {
        outcomes.push({ ok: true });
        res.writeHead(200).end('ok');
      })
      .catch((error: Error) => {
        outcomes.push({ ok: false, error });
        if (!res.writableEnded) res.writeHead(500).end('err');
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    destinationPath,
    outcomes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForOutcome(server: BodyServer): Promise<WriteOutcome> {
  for (let attempt = 0; attempt < 100 && server.outcomes.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const outcome = server.outcomes[0];
  assert.ok(outcome !== undefined, 'readBodyToFile must settle instead of hanging forever');
  return outcome;
}

test('readBodyToFile writes the whole body to disk', async () => {
  const server = await startBodyServer('read-body-file-ok-', 1024 * 1024);
  const payload = Buffer.alloc(300_000, 5);
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
      request.end(payload);
    });

    assert.deepEqual(await waitForOutcome(server), { ok: true });
    assert.deepEqual(fs.readFileSync(server.destinationPath), payload);
  } finally {
    await server.close();
  }
});

test('readBodyToFile rejects past the cap and leaves no partial file', async () => {
  const server = await startBodyServer('read-body-file-cap-', 64);
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
      request.end('x'.repeat(4096));
    });

    const outcome = await waitForOutcome(server);
    assert.equal(outcome.ok, false);
    assert.ok(
      outcome.ok === false && outcome.error instanceof RequestBodyTooLargeError,
      'oversize bodies must reject with RequestBodyTooLargeError',
    );
    assert.equal(fs.existsSync(server.destinationPath), false);
  } finally {
    await server.close();
  }
});

test('readBodyToFile settles and cleans up when the client aborts mid-body', async () => {
  const server = await startBodyServer('read-body-file-abort-', 1024 * 1024);
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    request.destroy();

    assert.equal((await waitForOutcome(server)).ok, false);
    assert.equal(fs.existsSync(server.destinationPath), false);
  } finally {
    await server.close();
  }
});
