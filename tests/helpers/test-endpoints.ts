import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { SIFT_DEFAULT_LLAMA_PORT, SIFT_DEFAULT_STATUS_PORT } from '../../src/config/constants.js';

const GUARDED_PORTS = new Set([SIFT_DEFAULT_LLAMA_PORT, SIFT_DEFAULT_STATUS_PORT]);
const PORT_LEASE_ROOT = path.join(fs.realpathSync(os.tmpdir()), 'siftkit-test-port-leases');
const FileErrorSchema = z.object({ code: z.string() });
const heldLeaseDirectories = new Set<string>();

export interface DeadHttpEndpoint {
  baseUrl: string;
  close(): Promise<void>;
}

export interface ChildPortLease {
  port: number;
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

class OwnedChildPortLease implements ChildPortLease {
  private released = false;

  constructor(
    readonly port: number,
    private readonly directory: string,
  ) {}

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    heldLeaseDirectories.delete(this.directory);
    fs.rmSync(this.directory, { recursive: true, force: true });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

function readServerPort(server: http.Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('HTTP server did not expose a TCP address after listening.');
  }
  return address.port;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function listenOnEphemeralPort(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return readServerPort(server);
}

export async function createDeadHttpEndpoint(): Promise<DeadHttpEndpoint> {
  const server = http.createServer();
  server.on('connection', (socket) => socket.destroy());
  const port = await listenOnEphemeralPort(server);
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}

async function reserveCandidatePort(): Promise<{ port: number; directory: string } | undefined> {
  const probe = http.createServer();
  const port = await listenOnEphemeralPort(probe);
  if (GUARDED_PORTS.has(port)) {
    await closeServer(probe);
    return undefined;
  }
  const directory = path.join(PORT_LEASE_ROOT, String(port));
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    await closeServer(probe);
    const parsed = FileErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === 'EEXIST') {
      return undefined;
    }
    throw error;
  }
  await closeServer(probe);
  return { port, directory };
}

export async function acquireChildPortLease(name: string): Promise<ChildPortLease> {
  fs.mkdirSync(PORT_LEASE_ROOT, { recursive: true });
  for (;;) {
    const reservation = await reserveCandidatePort();
    if (!reservation) continue;
    const { port, directory } = reservation;
    fs.writeFileSync(
      path.join(directory, 'owner.json'),
      `${JSON.stringify({ name, pid: process.pid })}\n`,
      'utf8',
    );
    heldLeaseDirectories.add(directory);
    return new OwnedChildPortLease(port, directory);
  }
}

process.on('exit', () => {
  for (const directory of heldLeaseDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
