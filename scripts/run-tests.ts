import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildNodeTestArgs } from './test-targets.js';

const repoRoot = process.cwd();
// tsx travels as an execArgv flag on the `node --test` process, never in NODE_OPTIONS.
// Node's test runner hands its execArgv to the per-file children, which need tsx to load
// .ts, and the flag stops there. In NODE_OPTIONS it would also reach the production CLIs
// and servers those tests spawn, where tsx's CJS hook transpiles the ESM dist/** tree into
// CommonJS: `import '@siftkit/contracts'` becomes a require() that the package's exports
// map (types + import, no require condition) cannot resolve, and the child dies with
// ERR_PACKAGE_PATH_NOT_EXPORTED. Those processes must run dist/** as the ESM they ship.
const tsxLoaderUrl = pathToFileURL(path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
// The guard does travel in NODE_OPTIONS, because catching a leak from a spawned CLI is
// exactly its job. It is the compiled sibling of this file, so no loader is needed to read
// it, and the URL is absolute so a child in a temp cwd resolves it like one in the repo.
const liveInstanceGuardUrl = pathToFileURL(path.resolve(__dirname, 'live-instance-guard.js')).href;
const testArgs = buildNodeTestArgs(repoRoot, process.argv.slice(2));
const result = spawnSync(process.execPath, ['--import', tsxLoaderUrl, '--test', ...testArgs], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // Ports the guard protects. They are spelled out rather than imported from
    // src/config/constants.ts: this file is run from dist/scripts, where that import
    // resolves into the dist/src tree, which cannot load. tests/live-instance-guard.test.ts
    // asserts a child of this run blocks exactly SIFT_DEFAULT_STATUS_PORT and
    // SIFT_DEFAULT_LLAMA_PORT, so drift here fails the suite instead of going quiet.
    SIFTKIT_GUARD_STATUS_PORT: '4765',
    SIFTKIT_GUARD_LLAMA_PORT: '8097',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${liveInstanceGuardUrl}`.trim(),
  },
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
