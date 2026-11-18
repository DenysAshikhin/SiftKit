import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SIFT_DEFAULT_ENGINE_PORT,
  SIFT_DEFAULT_EXL3_PYTHON_PATH,
  SIFT_DEFAULT_EXL3_WORKING_DIRECTORY,
  SIFT_DEFAULT_STATUS_PORT,
} from '../config/constants.ts';
import { AGENT_RUN_ID_ENV, AGENT_SERVER_URL_ENV } from '../lib/agent-run-marker.ts';
import { RUNTIME_DIR_NAME } from '../lib/paths.ts';

export const TESTS_DIRECTORY = 'tests';
const HERMETIC_FS_PATH = path.join(TESTS_DIRECTORY, 'helpers', 'hermetic-fs.ts');

const NESTED_RUN_MARKER = new Set([AGENT_RUN_ID_ENV, AGENT_SERVER_URL_ENV]);

/**
 * The env a test run starts with: the caller's plus the guard's, minus the nested-run marker. An agent's shell
 * carries that marker, and the CLI under test would refuse its server calls only when an agent started the suite.
 */
export function buildTestEnv(repoRoot: string, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(parent).filter(([name]) => !NESTED_RUN_MARKER.has(name)));
  return { ...inherited, ...buildGuardEnv(repoRoot) };
}

/** Env the live-instance guard reads; ports and engine paths come from the constants src uses, so they cannot drift. */
export function buildGuardEnv(repoRoot: string): Record<string, string> {
  return {
    SIFTKIT_GUARD_STATUS_PORT: String(SIFT_DEFAULT_STATUS_PORT),
    SIFTKIT_GUARD_ENGINE_PORT: String(SIFT_DEFAULT_ENGINE_PORT),
    SIFTKIT_GUARD_ENGINE_PATHS: [SIFT_DEFAULT_EXL3_PYTHON_PATH, SIFT_DEFAULT_EXL3_WORKING_DIRECTORY].join(path.delimiter),
    SIFTKIT_GUARD_RUNTIME_DATABASE: path.resolve(repoRoot, RUNTIME_DIR_NAME, 'runtime.sqlite'),
    SIFTKIT_GUARD_HERMETIC_FS: pathToFileURL(path.resolve(repoRoot, HERMETIC_FS_PATH)).href,
  };
}
