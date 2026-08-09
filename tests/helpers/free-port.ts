import http from 'node:http';

import { SIFT_DEFAULT_LLAMA_PORT, SIFT_DEFAULT_STATUS_PORT } from '../../src/config/constants.js';

const GUARDED_PORTS = new Set([SIFT_DEFAULT_STATUS_PORT, SIFT_DEFAULT_LLAMA_PORT]);

/** Reserves an ephemeral port that can be handed to a child without tripping the live-instance guard. */
export async function getFreePort(): Promise<number> {
  for (;;) {
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => error ? reject(error) : resolve());
    });
    if (port > 0 && !GUARDED_PORTS.has(port)) {
      return port;
    }
  }
}
