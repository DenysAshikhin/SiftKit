# Live-Instance Guard Drift Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the five drifts introduced with the live-instance guard: re-hardcoded default ports in the test runner, a fourth hand-written env save/restore branch, an unused option on `ChildEnvOptions`, two byte-identical proxy handlers, and a guard signature that disagrees with its own null check.

**Architecture:** `src/config/constants.ts` stops assuming its own depth under the output root and locates the SiftKit `package.json` with the existing `findNearestSiftKitRepoRoot` walk, which makes it loadable from every emitted tree (`dist/**`, `dist/src/**`, `src/**`). That single fix lets `scripts/run-tests.ts` import `SIFT_DEFAULT_STATUS_PORT`/`SIFT_DEFAULT_LLAMA_PORT` instead of re-spelling them, so the ports live in exactly one place. Env save/restore becomes one leaf class, `tests/helpers/env-backup.ts`, with no repo imports, reused by every helper that currently open-codes the `undefined ? delete : assign` branch. The guard itself collapses its two identical `ProxyHandler` objects into one and widens `assertRequestAllowed` to the type its own guard clause already implies.

**Tech Stack:** TypeScript 5.9, Node.js 24 test runner (`node --test`), `tsx`, `c8`, ESLint, zod.

---

## Global Constraints

- Use TDD: write or extend the test first, observe the specified failure, then implement.
- No type-assertion casts (`x as T`, `<T>x`), no `any`, no non-null `!`, no namespace imports (`import * as X`). `as const` and `satisfies` are allowed.
- No shims, no legacy compatibility, no re-export stubs. When a helper moves, its old definition is deleted and every importer is updated in the same task.
- Keep functions explicit; do not inject behavior through callbacks or predicates.
- `scripts/live-instance-guard.ts` is a Node `--import` preload and **must keep importing nothing but `node:` builtins**. It runs inside every process the suite touches, including the production CLIs and servers the tests spawn, so anything it imports is injected into those processes' module graphs. Do not "fix" the port env by importing constants there.
- Do not use a worktree.
- All shell commands are PowerShell. `&&` is not available: use `cmd; if ($?) { cmd2 }`.
- Every task ends with a commit.

### Verified facts this plan depends on

These were measured against the working tree before the plan was written; do not re-derive them.

1. `dist/package.json` is `{ "type": "module" }` — it has no `version`, so `dist/src/config/constants.js` resolving `../../package.json` lands on it and throws `ZodError: version — expected string, received undefined`. `dist/config/constants.js` resolves to the repo root and loads fine.
2. `dist/src/**` is not dead: `tsc -p tsconfig.json` emits there (the `@siftkit/contracts` `paths` mapping pulls the inferred `rootDir` up to the repo root) and `scripts/sync-dist-runtime.js:35` flattens `dist/src/*` into `dist/*`. Any script under `dist/scripts/**` that imports `../src/...` resolves into `dist/src/**`, so fact 1 is a live trap, not cosmetic.
3. `findNearestSiftKitRepoRoot('<repo>/dist/src/config')` returns `<repo>` — `dist/package.json` has no `name`, so the walk skips it and keeps going. Verified by running it.
4. `scripts/run-tests.ts` importing `../src/config/constants.js` typechecks under `tsconfig.scripts.json --noEmit` and emits `require("../src/config/constants.js")` from CommonJS. Node 24 `require(esm)` loads it (the only failure observed was fact 1's `ZodError`, i.e. the module body ran). Verified by compiling a probe and running it.
5. A single `const handler: ProxyHandler<typeof http.request>` typechecks for both `new Proxy(http.request, handler)` and `new Proxy(https.request, handler)` with no cast. Verified with `tsc --noEmit`.
6. `http.request()` with no arguments does **not** throw synchronously; Node defaults to `localhost:80` and fails asynchronously. With the guard preloaded, a child that calls `http.request()`, attaches an `error` handler and calls `destroy()` exits 0. Verified by running it.

---

## File Structure

- Modify `src/config/constants.ts:1-12` — resolve the SiftKit `package.json` by walking up from the module, so the module loads from any emitted tree.
- Modify `scripts/run-tests.ts:17-27` — import the two port constants instead of writing `'4765'`/`'8097'`, and replace the comment that justified the literals.
- Modify `tests/config.test.ts:69-74` — add the E2E that loads the emitted `dist/src/config/constants.js` in a child process.
- Create `tests/helpers/env-backup.ts` — leaf `EnvBackup` class, `node:`-free and repo-import-free, so every test helper can reuse it without dragging in `better-sqlite3`.
- Create `tests/env-backup.test.ts` — behavioral coverage for `EnvBackup` and for `DeadEndpointEnv`'s apply/restore contract.
- Modify `tests/_test-helpers.ts:472-494,507-512,558-564` — delete the local `withEnvBackup`/`EnvBackup` pair, use the new class.
- Modify `tests/helpers/dead-endpoints.ts:15-38` — hold an `EnvBackup` instead of two hand-written restore branches.
- Modify `tests/_runtime-helpers.ts:985-1043,1067-1090` — replace the open-coded restore loops in `runWithTempEnv` and `withStubServer`.
- Modify `tests/live-instance-guard.test.ts` — collapse `ChildEnvOptions` to what callers use, parameterise the child-source builder by protocol, add `https` and no-argument coverage, refresh the stale comment.
- Modify `scripts/live-instance-guard.ts:11,80-124` — one shared request `ProxyHandler`, honest `assertRequestAllowed` signature, corrected sibling-path reference in the header.

**Prerequisite already completed (commit `28c9ec6`).** Before this plan could start, the suite had 7 failing tests. Root cause: the guard was preloaded as TypeScript, which forced the tsx loader into `NODE_OPTIONS`; every descendant inherited it, and tsx's CJS hook transpiled the ESM `dist/**` tree into CommonJS inside spawned production CLIs, so `import '@siftkit/contracts'` became a `require()` the package's exports map cannot resolve. The guard moved from `tests/` to `scripts/live-instance-guard.ts` (compiled to `dist/scripts/live-instance-guard.js` and preloaded as plain JS), and tsx now travels as an execArgv flag on the `node --test` process. Suite is green at 1841 pass / 0 fail / 2 skipped, branches **80.81%** — that is the baseline Task 5 compares against, superseding Task 1 Step 1.

**Out of scope, deliberately:** roughly 60 further hand-written `if (value === undefined) delete process.env[key]` sites reachable from `configureDashboardTestEnv` (`tests/dashboard-status-server.test.ts`, `tests/repo-search-status-server.test.ts`, `tests/summary-status-server.test.ts`, `tests/config.test.ts`, and others). They are the same defect at a scale that does not belong in this repair; migrating them to `EnvBackup` is a separate mechanical sweep. This plan converts the four sites named in the review plus the one existing `withEnvBackup` caller.

---

### Task 1: Make `src/config/constants.ts` loadable from every emitted tree and stop re-spelling the ports

**Files:**
- Modify: `tests/config.test.ts:69-74`
- Modify: `src/config/constants.ts:1-12`
- Modify: `scripts/run-tests.ts:17-27`
- Modify: `scripts/live-instance-guard.ts:10-19`
- Modify: `tests/live-instance-guard.test.ts:145-148`

**Interfaces:**
- Consumes: `findNearestSiftKitRepoRoot(startPath: string): string | null` and `moduleDirname(moduleUrl: string): string` from `src/lib/paths.ts`.
- Produces: unchanged public surface — `SIFTKIT_VERSION`, `SIFT_DEFAULT_STATUS_PORT`, `SIFT_DEFAULT_LLAMA_PORT`, and the rest of `src/config/constants.ts`.

- [x] **Step 1: Record the coverage baseline before touching anything**

Done as part of the prerequisite commit `28c9ec6`. Baseline: suite green at 1841 pass / 0 fail / 2 skipped, **branches 80.81%**. Task 5 compares against that number. No scratch folder was needed.

- [ ] **Step 2: Write the failing test**

In `tests/config.test.ts`, add these imports to the existing `node:` import block at the top of the file (lines 1-6), keeping them in the same style:

```ts
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
```

Then insert this test immediately after the `SIFTKIT_VERSION matches package.json version` test that ends at line 74:

```ts
// scripts/run-tests.ts runs from dist/scripts and imports this module as
// dist/src/config/constants.js, one level deeper than dist/config/constants.js.
// The module must therefore find the SiftKit package.json by walking up rather
// than by assuming its own depth, or the import throws on dist/package.json,
// which carries only { "type": "module" }.
test('the emitted dist/src copy of the constants module loads and reports the package version', () => {
  const emittedConstantsPath = path.resolve(__dirname, '..', 'dist', 'src', 'config', 'constants.js');
  assert.ok(
    fs.existsSync(emittedConstantsPath),
    `${emittedConstantsPath} is missing; run "npm run build:test" before this test.`,
  );

  const childSource = `const constants = await import(${JSON.stringify(pathToFileURL(emittedConstantsPath).href)});`
    + 'process.stdout.write(constants.SIFTKIT_VERSION);';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.equal(result.status, 0, `loading the emitted constants failed: ${result.stderr}`);
  assert.equal(result.stdout, SIFTKIT_VERSION);
});
```

- [ ] **Step 3: Run the test and confirm it fails for the documented reason**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\scripts\run-tests.js config.test.ts }
```

Expected: the new test FAILS. `result.status` is 1 and the assertion message contains
`ZodError` with `"path": [ "version" ]` and `expected string, received undefined`.

If instead the assertion message says `dist\src\config\constants.js is missing`, the build did not run — fix that before continuing; the failure must be the `ZodError`.

- [ ] **Step 4: Make the constants module locate the package root by walking up**

Replace lines 1-12 of `src/config/constants.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findNearestSiftKitRepoRoot, moduleDirname } from '../lib/paths.js';
import { z } from '../lib/zod.js';

const PackageJsonSchema = z.object({ version: z.string() });

// The compiled copies of this module sit at different depths under the output
// root: dist/config/constants.js after scripts/sync-dist-runtime.js flattens the
// tree, and dist/src/config/constants.js in the tree it flattens from, which
// dist/scripts/** imports. A fixed '..','..' hop is only correct for one of
// them, and the wrong one lands on dist/package.json, which has no version.
// Walk up to the nearest package.json named "siftkit" instead.
const moduleDirectory = moduleDirname(import.meta.url);
const packageRoot = findNearestSiftKitRepoRoot(moduleDirectory);
if (!packageRoot) {
  throw new Error(
    `No SiftKit package.json found above ${moduleDirectory}. `
    + 'The SiftKit install is incomplete: its package.json must be reachable from the compiled output.',
  );
}

const packageJson = PackageJsonSchema.parse(JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
));

export const SIFTKIT_VERSION = packageJson.version;
```

Leave lines 13 onward (`SIFT_DEFAULT_NUM_CTX` through `RuntimeOwnedLlamaCppKey`) exactly as they are.

- [ ] **Step 5: Run the test and confirm it passes**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\scripts\run-tests.js config.test.ts }
```

Expected: PASS, including the pre-existing `SIFTKIT_VERSION matches package.json version` test.

- [ ] **Step 6: Import the ports in the runner instead of re-spelling them**

Add this import to `scripts/run-tests.ts` after the `buildNodeTestArgs` import on line 5:

```ts
import { SIFT_DEFAULT_LLAMA_PORT, SIFT_DEFAULT_STATUS_PORT } from '../src/config/constants.js';
```

Replace the `env` block at lines 17-27 with:

```ts
  env: {
    ...process.env,
    // The guard preload cannot import this module: it runs during the --import
    // phase, where the tsx resolve hook needed to map the .js specifier onto .ts
    // deadlocks the process. The ports therefore travel to it as env, sourced
    // from the same constants src uses so there is nothing to keep in sync.
    SIFTKIT_GUARD_STATUS_PORT: String(SIFT_DEFAULT_STATUS_PORT),
    SIFTKIT_GUARD_LLAMA_PORT: String(SIFT_DEFAULT_LLAMA_PORT),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${tsxLoaderUrl} --import ${liveInstanceGuardUrl}`.trim(),
  },
```

- [ ] **Step 7: Refresh the two comments that documented the literals**

In `scripts/live-instance-guard.ts`, line 11 still points at `./helpers/dead-endpoints.ts`, which was correct when the guard lived in `tests/`. Fix the path and name the constants source. Replace lines 10-19 with:

```
 * default port therefore fails the test file that made it. Isolation is each file's job:
 * boot a stub, or declare a dead backend with the fixtures in tests/helpers/dead-endpoints.ts.
 *
 * This module must import nothing but node: builtins. It is preloaded through NODE_OPTIONS,
 * so it runs inside every process the suite touches — including the production CLIs and
 * servers the tests spawn. Anything it imports is injected into those processes' module
 * graphs, which both slows them down and stops them from exercising the artifact they ship.
 * The ports therefore arrive as env from scripts/run-tests.ts, which reads them from
 * src/config/constants.ts.
```

In `tests/live-instance-guard.test.ts`, replace the comment above the two suite-wiring tests with:

```ts
// scripts/run-tests.ts passes the guarded ports as env because the preload cannot import
// a repo module. These two cases prove that hand-off: they inherit the suite's own
// environment and assert it protects exactly the constants src uses.
```

- [ ] **Step 8: Run the guard suite and confirm the runner wiring still holds**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\scripts\run-tests.js live-instance-guard.test.ts }
```

Expected: all 8 tests PASS, in particular `the suite guards the default status port for every child it spawns` and `the suite guards the default llama port for every child it spawns` — these run through the freshly compiled `dist/scripts/run-tests.js`, so they prove the `require(esm)` hop into `dist/src/config/constants.js` works.

- [ ] **Step 9: Commit**

```powershell
git add src/config/constants.ts scripts/run-tests.ts tests/config.test.ts scripts/live-instance-guard.ts tests/live-instance-guard.test.ts
git commit -m "fix: resolve the SiftKit package.json by walking up so every emitted tree can load the constants"
```

---

### Task 2: One `EnvBackup` class for every env save/restore site

**Files:**
- Create: `tests/env-backup.test.ts`
- Create: `tests/helpers/env-backup.ts`
- Modify: `tests/helpers/dead-endpoints.ts:15-38`
- Modify: `tests/_test-helpers.ts:472-494,507-512`
- Modify: `tests/_runtime-helpers.ts:985-1043,1067-1090`

**Interfaces:**
- Produces: `class EnvBackup` with `constructor(keys: readonly string[])` (captures `process.env[key]` for each key immediately) and `restore(): void` (re-assigns captured values, `delete`s keys that were absent, idempotent).
- Removes: `withEnvBackup(envKeys: string[]): EnvBackup` and the `EnvBackup` object type from `tests/_test-helpers.ts`. Nothing outside that file imported them, and nothing read the `backup` property — only `restore()` was ever called (`tests/_test-helpers.ts:562`).

- [ ] **Step 1: Write the failing test**

Create `tests/env-backup.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvBackup } from './helpers/env-backup.js';
import { DEAD_CONFIG_SERVICE_URL, DEAD_STATUS_BACKEND_URL, DeadEndpointEnv } from './helpers/dead-endpoints.js';

// node --test runs every test file in its own process, so mutating process.env
// here cannot leak into another file.
const PRESENT_KEY = 'SIFTKIT_ENV_BACKUP_PRESENT';
const ABSENT_KEY = 'SIFTKIT_ENV_BACKUP_ABSENT';

test('EnvBackup re-assigns a key that was set and deletes one that was not', () => {
  process.env[PRESENT_KEY] = 'original';
  delete process.env[ABSENT_KEY];

  const backup = new EnvBackup([PRESENT_KEY, ABSENT_KEY]);
  process.env[PRESENT_KEY] = 'mutated';
  process.env[ABSENT_KEY] = 'added';
  backup.restore();

  assert.equal(process.env[PRESENT_KEY], 'original');
  assert.equal(ABSENT_KEY in process.env, false);
  delete process.env[PRESENT_KEY];
});

test('EnvBackup restore is idempotent', () => {
  delete process.env[ABSENT_KEY];
  const backup = new EnvBackup([ABSENT_KEY]);

  process.env[ABSENT_KEY] = 'added';
  backup.restore();
  process.env[ABSENT_KEY] = 'added again';
  backup.restore();

  assert.equal(ABSENT_KEY in process.env, false);
});

test('EnvBackup with no keys restores nothing', () => {
  process.env[PRESENT_KEY] = 'untouched';
  new EnvBackup([]).restore();

  assert.equal(process.env[PRESENT_KEY], 'untouched');
  delete process.env[PRESENT_KEY];
});

test('DeadEndpointEnv points the status and config env at a dead port and puts both back', () => {
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:2/status';
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;

  const deadEndpoints = new DeadEndpointEnv();
  deadEndpoints.apply();
  assert.equal(process.env.SIFTKIT_STATUS_BACKEND_URL, DEAD_STATUS_BACKEND_URL);
  assert.equal(process.env.SIFTKIT_CONFIG_SERVICE_URL, DEAD_CONFIG_SERVICE_URL);

  deadEndpoints.restore();
  assert.equal(process.env.SIFTKIT_STATUS_BACKEND_URL, 'http://127.0.0.1:2/status');
  assert.equal('SIFTKIT_CONFIG_SERVICE_URL' in process.env, false);
  delete process.env.SIFTKIT_STATUS_BACKEND_URL;
});

test('DeadEndpointEnv.restore before apply fails loudly instead of silently doing nothing', () => {
  assert.throws(() => new DeadEndpointEnv().restore(), /restore\(\) was called before apply\(\)/u);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
node .\dist\scripts\run-tests.js env-backup.test.ts
```

Expected: FAIL — `Cannot find module './helpers/env-backup.js'` (the `ERR_MODULE_NOT_FOUND` surfaces as a load error for the whole file).

- [ ] **Step 3: Create the leaf helper**

Create `tests/helpers/env-backup.ts`:

```ts
/**
 * Captures the given environment variables on construction and puts them back on
 * restore(): re-assigning the ones that were set, deleting the ones that were not.
 *
 * This is a leaf module on purpose. It imports nothing, so helpers that must stay
 * light — tests/helpers/dead-endpoints.ts, for one — can reuse it without pulling in
 * the runtime database and better-sqlite3 that tests/_test-helpers.ts brings along.
 */
export class EnvBackup {
  private readonly previousValues: ReadonlyMap<string, string | undefined>;

  constructor(keys: readonly string[]) {
    this.previousValues = new Map(keys.map((key) => [key, process.env[key]]));
  }

  restore(): void {
    for (const [key, value] of this.previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
```

- [ ] **Step 4: Rewrite `DeadEndpointEnv` on top of it**

Replace the whole of `tests/helpers/dead-endpoints.ts` with:

```ts
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
```

The three exported `DEAD_*` constants keep their existing names, values, and header comment — three test files import them (`tests/_runtime-helpers.ts:18`, `tests/summary-core-runner.test.ts:10`, `tests/dashboard-metrics-unconfigured-managed.test.ts:12`).

- [ ] **Step 5: Run the test and confirm it passes**

Run:

```powershell
node .\dist\scripts\run-tests.js env-backup.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Delete the duplicate in `tests/_test-helpers.ts` and use the class**

Delete lines 472-494 of `tests/_test-helpers.ts` entirely — the `export type EnvBackup = { backup; restore }` alias and the `export function withEnvBackup`. Add to the import block at the top of the file, next to the other `./helpers/*` imports on lines 12-13:

```ts
import { EnvBackup } from './helpers/env-backup.js';
```

Replace lines 507-512 with:

```ts
  const envBackup = new EnvBackup([
    'sift_kit_status', 'SIFTKIT_STATUS_PATH', 'SIFTKIT_CONFIG_PATH',
    'SIFTKIT_STATUS_HOST', 'SIFTKIT_STATUS_PORT', 'SIFTKIT_STATUS_BACKEND_URL',
    'SIFTKIT_CONFIG_SERVICE_URL', 'USERPROFILE', 'SIFTKIT_TEST_PROVIDER',
    'SIFTKIT_IDLE_SUMMARY_DB_PATH', 'SIFTKIT_LOCK_TIMEOUT_MS',
  ]);
```

and change the `env.restore();` call on line 562 to:

```ts
    envBackup.restore();
```

- [ ] **Step 7: Replace the open-coded restore in `runWithTempEnv`**

In `tests/_runtime-helpers.ts`, add to the `./helpers/*` import group (near line 17-18):

```ts
import { EnvBackup } from './helpers/env-backup.js';
```

Replace lines 988-1004 (the `const previous = { ... };` object) with:

```ts
  const envBackup = new EnvBackup([
    'USERPROFILE',
    'sift_kit_status',
    'SIFTKIT_STATUS_PATH',
    'SIFTKIT_CONFIG_PATH',
    'SIFTKIT_TEST_PROVIDER',
    'SIFTKIT_TEST_PROVIDER_BEHAVIOR',
    'SIFTKIT_TEST_PROVIDER_LOG_PATH',
    'SIFTKIT_TEST_PROVIDER_SLEEP_MS',
    'SIFTKIT_CONFIG_SERVICE_URL',
    'SIFTKIT_STATUS_BACKEND_URL',
    'SIFTKIT_STATUS_PORT',
    'SIFTKIT_STATUS_HOST',
    'SIFTKIT_IDLE_SUMMARY_DB_PATH',
    'SIFTKIT_IDLE_SUMMARY_DELAY_MS',
    'SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS',
  ]);
```

The key list must stay exactly these 15 names in this order — it is the same set the deleted object captured. Then replace the restore loop inside `cleanup` (lines 1030-1036) with:

```ts
    envBackup.restore();
```

so `cleanup` reads:

```ts
  const cleanup = async () => {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    envBackup.restore();
    await removeDirectoryWithRetries(tempRoot);
  };
```

- [ ] **Step 8: Replace the open-coded restore in `withStubServer`**

Replace lines 1067-1090 of `tests/_runtime-helpers.ts` with:

```ts
async function withStubServer<R>(fn: (server: StubServer) => R | Promise<R>, options: StubServerOptions = {}): Promise<R> {
  const envBackup = new EnvBackup(['SIFTKIT_STATUS_BACKEND_URL', 'SIFTKIT_CONFIG_SERVICE_URL']);
  const server = await startStubStatusServer(options);
  process.env.SIFTKIT_STATUS_BACKEND_URL = server.statusUrl;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = server.configUrl;
  try {
    return await fn(server);
  } finally {
    await server.close();
    envBackup.restore();
  }
}
```

- [ ] **Step 9: Run every suite that exercises the four migrated call sites**

Run:

```powershell
node .\dist\scripts\run-tests.js env-backup.test.ts; if ($?) { node .\dist\scripts\run-tests.js config.test.ts }
if ($?) { node .\dist\scripts\run-tests.js repo-search-agent-execute.test.ts }
if ($?) { node .\dist\scripts\run-tests.js repo-search-chat-execute.test.ts }
if ($?) { node .\dist\scripts\run-tests.js summary-request-runner.test.ts }
if ($?) { node .\dist\scripts\run-tests.js runtime-summarize.test.ts }
if ($?) { node .\dist\scripts\run-tests.js timing-recorder.test.ts }
```

Expected: PASS everywhere. `config.test.ts` covers `withTestEnvAndServer`, the two `repo-search-*-execute` files and `summary-request-runner` cover `DeadEndpointEnv`, and `runtime-summarize`/`timing-recorder` cover `withStubServer` and `withTempEnv`.

- [ ] **Step 10: Commit**

```powershell
git add tests/helpers/env-backup.ts tests/env-backup.test.ts tests/helpers/dead-endpoints.ts tests/_test-helpers.ts tests/_runtime-helpers.ts
git commit -m "refactor: replace four hand-written env restore branches with one EnvBackup class"
```

---

### Task 3: Collapse `ChildEnvOptions` to the options that have callers

**Files:**
- Modify: `tests/live-instance-guard.test.ts:27-44,134-143`

**Interfaces:**
- Produces: `interface ChildEnvOptions { preloadGuard?: boolean; omitStatusPort?: boolean }`. `statusPort?: string` and `llamaPort?: string` are gone; `llamaPort` had zero callers and `statusPort` had exactly one, always `''`.
- Behavior change: the missing-env case now genuinely omits `SIFTKIT_GUARD_STATUS_PORT` instead of setting it to `''`. `readGuardedPort` in `scripts/live-instance-guard.ts:31-40` treats both identically (`process.env[envName]?.trim()` is falsy either way), so the assertion on `/SIFTKIT_GUARD_STATUS_PORT is not set/u` still holds — and now matches what the test name claims.

- [ ] **Step 1: Rewrite the options interface and the env builder**

Replace lines 27-44 of `tests/live-instance-guard.test.ts` with:

```ts
interface ChildEnvOptions {
  /** Omit to inherit the suite's own NODE_OPTIONS, which is how the wiring gets tested. */
  preloadGuard?: boolean;
  /** Drops SIFTKIT_GUARD_STATUS_PORT so the guard's own missing-env failure can be asserted. */
  omitStatusPort?: boolean;
}

function buildChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  if (!options.preloadGuard) {
    return process.env;
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `--import ${tsxLoaderUrl} --import ${guardUrl}`,
    SIFTKIT_GUARD_STATUS_PORT: String(SIFT_DEFAULT_STATUS_PORT),
    SIFTKIT_GUARD_LLAMA_PORT: String(SIFT_DEFAULT_LLAMA_PORT),
  };
  if (options.omitStatusPort) {
    delete childEnv.SIFTKIT_GUARD_STATUS_PORT;
  }
  return childEnv;
}
```

- [ ] **Step 2: Point the missing-env test at the surviving option**

Replace the test at lines 134-143 with:

```ts
test('guard refuses to load unguarded when the port env is missing', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT, 'http'), {
    preloadGuard: true,
    omitStatusPort: true,
  });

  assertChildFinished(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SIFTKIT_GUARD_STATUS_PORT is not set/u);
});
```

The second argument to `buildSwallowedRequestSource` is added in Task 4 Step 2. Execute Task 4 in the same session and run the suite only after both edits are in place; if you are running Task 3 alone, write `buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT)` here and add the `'http'` argument in Task 4.

- [ ] **Step 3: Typecheck and run the guard suite**

Run:

```powershell
npm run typecheck:test; if ($?) { node .\dist\scripts\run-tests.js live-instance-guard.test.ts }
```

Expected: typecheck exits 0 (no unused-symbol or missing-property errors) and all 8 tests PASS, including `guard refuses to load unguarded when the port env is missing`.

- [ ] **Step 4: Commit**

```powershell
git add tests/live-instance-guard.test.ts
git commit -m "refactor: drop the unused port overrides from the guard test's child env options"
```

---

### Task 4: One request `ProxyHandler`, and a signature that matches its own guard clause

**Files:**
- Modify: `tests/live-instance-guard.test.ts:74-85` (builder gains a protocol argument), plus the six call sites at lines 88, 97, 105-108, 116-118, 127, 135
- Modify: `scripts/live-instance-guard.ts:80-124`

**Interfaces:**
- `buildSwallowedRequestSource(port: number, protocol: 'http' | 'https'): string` — a required second argument, no default, so each call site says which module it exercises.
- `assertRequestAllowed(requestTarget: string | URL | ClientRequestArgs | undefined): void` — the `undefined` is what the existing `if (!requestTarget) return;` clause was already handling; `http.request()` with no arguments really does reach the proxy with `argArray[0] === undefined`.
- `const requestGuard: ProxyHandler<typeof http.request>` — one object, applied to both `http.request` and `https.request`. Verified to typecheck for both with no cast.

**Note on TDD for this task:** the two new tests below are characterization coverage for paths that already work — `https.request` was proxied but never asserted, and the no-argument path was guarded but never exercised. They must pass **before** the refactor; that is what makes the refactor safe. Do not fake a red here: run them first, watch them pass, then collapse the duplication and watch them still pass.

- [ ] **Step 1: Add the two missing tests**

In `tests/live-instance-guard.test.ts`, replace the builder at lines 74-85 with:

```ts
/**
 * Mirrors the real leak: a fire-and-forget status notification whose error is swallowed,
 * so the process would otherwise exit 0 and the run would report green.
 */
function buildSwallowedRequestSource(port: number, protocol: 'http' | 'https'): string {
  return [
    `import ${protocol} from 'node:${protocol}';`,
    'try {',
    `  const request = ${protocol}.request({ hostname: '127.0.0.1', port: ${port}, path: '/status', method: 'POST' });`,
    "  request.on('error', () => {});",
    '  request.end();',
    '} catch {',
    '  // swallowed, exactly like the notification paths under test',
    '}',
  ].join('\n');
}
```

Add `, 'http'` to each existing call: lines 88, 97, 127, and the Task 3 call in the missing-env test. Then add these two tests immediately after `guard leaves an unguarded port alone` (which ends at line 132):

```ts
test('guard covers https.request, not just http.request', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT, 'https'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`live SiftKit status server on port ${SIFT_DEFAULT_STATUS_PORT}`, 'u'));
});

// http.request() with no arguments reaches the proxy with an undefined target and then
// defaults to localhost:80 inside Node. The guard has no port to check, so it must hand
// the call straight through rather than turning it into its own confusing TypeError.
test('guard passes through a request with no target and reports no violation', () => {
  const result = runGuardedChild([
    "import http from 'node:http';",
    'const request = http.request();',
    "request.on('error', () => {});",
    'request.destroy();',
  ].join('\n'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /LIVE INSTANCE CONTACTED/u);
});
```

- [ ] **Step 2: Run the suite and confirm all 10 tests pass against the unchanged guard**

Run:

```powershell
npm run typecheck:test; if ($?) { node .\dist\scripts\run-tests.js live-instance-guard.test.ts }
```

Expected: 10 tests PASS. If `guard covers https.request` fails, stop — the `https` proxy is broken today and that is a bug to fix before deduplicating anything.

- [ ] **Step 3: Commit the coverage before refactoring under it**

```powershell
git add tests/live-instance-guard.test.ts
git commit -m "test: cover the guard's https and no-target request paths"
```

- [ ] **Step 4: Collapse the two handlers and make the signature honest**

Replace lines 80-124 of `scripts/live-instance-guard.ts` with:

```ts
/**
 * http.request/fetch accept a URL string, a URL, or an options bag, and callers may pass
 * nothing at all — http.request() with no arguments reaches this proxy with an undefined
 * target and then defaults to localhost:80 inside Node. Only the port matters here.
 */
function assertRequestAllowed(requestTarget: string | URL | ClientRequestArgs | undefined): void {
  // No target means no port to check; leave that call to Node rather than to the guard.
  if (requestTarget === undefined) {
    return;
  }
  if (typeof requestTarget === 'string') {
    const parsedUrl = URL.parse(requestTarget);
    if (parsedUrl) {
      failOnGuardedPort(parsedUrl.port, requestTarget);
    }
    return;
  }
  if (requestTarget instanceof URL) {
    failOnGuardedPort(requestTarget.port, requestTarget.href);
    return;
  }
  failOnGuardedPort(String(requestTarget.port ?? ''), `${requestTarget.hostname ?? ''}${requestTarget.path ?? ''}`);
}

// http.request and https.request take their target in the same first argument, so one
// handler covers both; the Proxy keeps each module's own function as its target.
const requestGuard: ProxyHandler<typeof http.request> = {
  apply(target, thisArg, argArray) {
    assertRequestAllowed(argArray[0]);
    return Reflect.apply(target, thisArg, argArray);
  },
};

const fetchGuard: ProxyHandler<typeof globalThis.fetch> = {
  apply(target, thisArg, argArray) {
    const [input] = argArray;
    assertRequestAllowed(input instanceof Request ? input.url : input);
    return Reflect.apply(target, thisArg, argArray);
  },
};

http.request = new Proxy(http.request, requestGuard);
https.request = new Proxy(https.request, requestGuard);
globalThis.fetch = new Proxy(globalThis.fetch, fetchGuard);
```

- [ ] **Step 5: Run the suite and confirm the refactor changed nothing observable**

Run:

```powershell
npm run typecheck:test; if ($?) { node .\dist\scripts\run-tests.js live-instance-guard.test.ts }
```

Expected: the same 10 tests PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```powershell
git add scripts/live-instance-guard.ts
git commit -m "refactor: share one request proxy handler and widen the guard signature to match its null check"
```

---

### Task 5: Full validation

**Files:** none modified.

- [ ] **Step 1: Typecheck and lint the whole repo**

Run:

```powershell
npm run typecheck
```

Expected: exit 0. This runs the contracts build, all four `--noEmit` projects, the bench/test/analysis projects, and `eslint .`.

- [ ] **Step 2: Run the full suite**

Run:

```powershell
npm test
```

Expected: exit 0, no `LIVE INSTANCE CONTACTED` block on stderr, and zero failing tests. A `LIVE INSTANCE CONTACTED` line here means a test file is reaching the developer's running SiftKit — fix the offending file's isolation, do not weaken the guard.

- [ ] **Step 3: Confirm coverage did not regress**

Run:

```powershell
npm run test:coverage
```

Expected: the reported branch total is greater than or equal to the baseline recorded in Task 1 Step 1.

- [ ] **Step 4: Confirm the runner no longer spells the ports out**

Run:

```powershell
Select-String -Path 'scripts\run-tests.ts','tests\live-instance-guard.ts' -Pattern '\b4765\b|\b8097\b'
```

Expected: no output. Both files must reach the ports through `src/config/constants.ts` (the runner by import, the preload by the env the runner sets).

Note: `4765`/`8097` still appear as literals in roughly 70 other places — `dashboard/vite.config.ts`, `scripts/start-dev.ts:51`, `scripts/start-dev-ports.ts:64`, `scripts/profile-tool-loop-overhead.ts:94`, `src/status-server/index.ts:210,346`, and a long tail of test fixture URLs. That is a pre-existing pattern this plan does not touch; only the two files above regressed during the guard work, and only those two are in scope.

- [ ] **Step 5: Delete the scratch folder**

Run:

```powershell
Remove-Item -Recurse -Force 'C:\Users\denys\AppData\Local\Temp\claude\siftkit-drift-repairs'
```

- [ ] **Step 6: Confirm the working tree holds only intended changes**

Run:

```powershell
git status --porcelain
```

Expected: clean, or only the pre-existing unrelated changes that were already present before this plan started.
