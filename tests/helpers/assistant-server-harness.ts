import path from 'node:path';

import type { CaptureSubmissionDto } from '@siftkit/contracts';
import type { AssistantConfig } from '../../src/config/types.js';
import { getConfigPath } from '../../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.js';
import { startStatusServer } from '../../src/status-server/index.js';
import { z } from '../../src/lib/zod.js';
import { closeHttpServer, getAddressInfo, requestJson } from './dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './temp-dirs.js';

const BootstrapResponseSchema = z.object({ token: z.string().min(1) });

/** 1x1 PNG used wherever a test needs real, decodable capture pixels. */
export const CAPTURE_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function captureSubmissionDto(pixelSeed: string, perceptualHash: string): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: new Date().toISOString(),
    reason: 'fixed_cadence',
    display: {
      id: 'DISPLAY1', name: 'Monitor', primary: true,
      pixelWidth: 1920, pixelHeight: 1080, logicalWidth: 1920, logicalHeight: 1080,
      scaleFactor: 1,
    },
    foregroundContextKey: 'app:code|siftkit',
    foreground: {
      processName: 'Code.exe',
      executablePath: 'C:/Code.exe',
      applicationId: 'app:code',
      normalizedTitle: 'SiftKit',
      fullscreen: false,
    },
    pixelSha256: pixelSeed.repeat(64).slice(0, 64),
    perceptualHash,
    imageDataUrl: `data:image/png;base64,${CAPTURE_PNG_BYTES.toString('base64')}`,
  };
}

export interface AssistantServerHarness {
  readonly tempRoot: string;
  readonly baseUrl: string;
  /** Bearer auth for /assistant routes; the token came from a schema-parsed bootstrap. */
  readonly headers: Record<string, string>;
}

/**
 * Boots a real status server in an isolated temp repo with the given Assistant block,
 * bootstraps (and validates) an assistant token, runs `body`, then tears everything down.
 */
export async function withAssistantServer(
  prefix: string,
  assistant: AssistantConfig,
  body: (harness: AssistantServerHarness) => Promise<void>,
): Promise<void> {
  const tempRoot = createManagedTempDir(prefix);
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  writeConfig(getConfigPath(), { ...getDefaultConfig(), Assistant: assistant });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    const bootstrap = BootstrapResponseSchema.parse(
      (await requestJson(`${baseUrl}/assistant/auth/bootstrap`)).body,
    );
    await body({ tempRoot, baseUrl, headers: { Authorization: `Bearer ${bootstrap.token}` } });
  } finally {
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
}