import { EnvBackup } from './env-backup.js';

/**
 * Sandboxed tests must never fall back to the production status/llama ports, so the env
 * overrides point at a closed port instead of being unset. An unstubbed call then fails
 * fast and locally with ECONNREFUSED rather than reaching the developer's live SiftKit.
 */
export const DEAD_BASE_URL = 'http://127.0.0.1:1';
export const DEAD_STATUS_BACKEND_URL = `${DEAD_BASE_URL}/status`;
export const DEAD_CONFIG_SERVICE_URL = `${DEAD_BASE_URL}/config`;

const DEAD_ENDPOINT_ENV_KEYS = ['SIFTKIT_STATUS_BACKEND_URL', 'SIFTKIT_CONFIG_SERVICE_URL'] as const;

/**
 * Fixture for test files that call in-process code which fires status notifications but
 * assert nothing about them. Declares "this file has no status backend" explicitly, so
 * the isolation is visible in the file rather than inherited from the preload guard.
 *
 * The backup is taken in apply() rather than in the constructor because callers construct
 * the fixture at module load and apply it from before().
 */
export class DeadEndpointEnv {
  private envBackup: EnvBackup | undefined = undefined;

  apply(): void {
    this.envBackup = new EnvBackup([...DEAD_ENDPOINT_ENV_KEYS]);
    process.env.SIFTKIT_STATUS_BACKEND_URL = DEAD_STATUS_BACKEND_URL;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = DEAD_CONFIG_SERVICE_URL;
  }

  restore(): void {
    if (!this.envBackup) {
      throw new Error('DeadEndpointEnv.restore() was called before apply(); there is nothing to put back.');
    }
    this.envBackup.restore();
  }
}
