import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStatusServer } from '../../src/status-server/index.js';
import { closeRuntimeDatabase } from '../../src/state/runtime-db.js';
import { getAddressInfo } from './dashboard-http.js';

export type StreamedOperationHarness = { baseUrl: string; close: () => Promise<void> };

export async function startHarness(namePrefix: string): Promise<StreamedOperationHarness> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), namePrefix));
  const previousCwd = process.cwd();
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'siftkit', version: '0.1.0' }), 'utf8');
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = path.join(tempRoot, '.siftkit', 'config.json');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 50 });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `${baseUrl}/config`;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${baseUrl}/status`;
  return {
    baseUrl,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      process.chdir(previousCwd);
      closeRuntimeDatabase();
      for (const [key, value] of Object.entries(envBackup)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}
