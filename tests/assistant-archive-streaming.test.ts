import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { TempArchiveBuilder, type TempArchive } from '../src/assistant/control/temp-archive.js';
import { sendArchive } from '../src/status-server/routes/assistant/helpers.js';
import { readArchiveEntriesFromBytes } from './helpers/archive-bytes.js';

/** Large enough that the client gets a chance to hang up before the body finishes. */
const PAYLOAD_BYTES = 8 * 1024 * 1024;

function buildArchive(): TempArchive {
  const builder = new TempArchiveBuilder('siftkit-archive-stream-');
  builder.writer.addBuffer('payload.bin', Buffer.alloc(PAYLOAD_BYTES, 0xab));
  return builder.finish();
}

async function serveOnce(archive: TempArchive): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer((_request, response) => {
    void sendArchive(response, archive);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/`, server };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForRemoval(target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!fs.existsSync(target)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !fs.existsSync(target);
}

test('sendArchive streams the archive and then deletes it', async () => {
  const archive = buildArchive();
  const directory = path.dirname(archive.path);
  const { url, server } = await serveOnce(archive);
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(
      (await readArchiveEntriesFromBytes(body)).get('payload.bin')?.byteLength,
      PAYLOAD_BYTES,
    );
    assert.equal(await waitForRemoval(directory), true, 'archive directory must be removed');
  } finally {
    await closeServer(server);
  }
});

test('sendArchive deletes the archive when the client disconnects mid-download', async () => {
  const archive = buildArchive();
  const directory = path.dirname(archive.path);
  const { url, server } = await serveOnce(archive);
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(url, (response) => {
        response.destroy();
        resolve();
      });
      request.on('error', reject);
    });
    assert.equal(await waitForRemoval(directory), true, 'archive directory must be removed');
  } finally {
    await closeServer(server);
  }
});
