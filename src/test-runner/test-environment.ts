import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SIFT_DEFAULT_ENGINE_PORT, SIFT_DEFAULT_STATUS_PORT } from '../config/constants.ts';
import { RUNTIME_DIR_NAME } from '../lib/paths.ts';

export const TESTS_DIRECTORY = 'tests';
const HERMETIC_FS_PATH = path.join(TESTS_DIRECTORY, 'helpers', 'hermetic-fs.ts');

/** Env the live-instance guard reads; ports come from the constants src uses, so they cannot drift. */
export function buildGuardEnv(repoRoot: string): Record<string, string> {
  return {
    SIFTKIT_GUARD_STATUS_PORT: String(SIFT_DEFAULT_STATUS_PORT),
    SIFTKIT_GUARD_ENGINE_PORT: String(SIFT_DEFAULT_ENGINE_PORT),
    SIFTKIT_GUARD_RUNTIME_DATABASE: path.resolve(repoRoot, RUNTIME_DIR_NAME, 'runtime.sqlite'),
    SIFTKIT_GUARD_HERMETIC_FS: pathToFileURL(path.resolve(repoRoot, HERMETIC_FS_PATH)).href,
  };
}
