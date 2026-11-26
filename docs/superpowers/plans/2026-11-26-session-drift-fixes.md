# Session Drift Fixes Implementation Plan

> **For agentic workers:** Implement one task at a time, test-first. Do not commit. Do not create temp files outside the test's managed temp dirs. Do not touch other tasks.

**Goal:** Fix the 13 directive violations found in the uncommitted orchestrator run ba44c0a8 diff.

**Architecture:** Each task is a self-contained refactor or bug fix with its own regression test. There are no shims: replaced code is deleted.

**Tech Stack:** TypeScript on Node 26 (native type stripping), node:test, better-sqlite3, zod.

**Commands:**
- One test file: `node ./src/test-runner/run-tests.ts <file-name-without-.test.ts>`. Add `--process` for files under `tests/process/`.
- Typecheck and lint: `npm run typecheck`.

**Rules (CLAUDE.md):**
- No `as` casts, `any`, non-null `!`, or namespace imports.
- No `z.custom` branding of fake objects.
- Comments are 1-2 lines.

---

### Task 1: Process-exit paths must kill the engine tree synchronously

**Problem:** `ManagedTabbyRuntime.stopForProcessExitSync()` (`src/status-server/managed-tabby.ts:279`) now calls `void this.host.launcher.terminate(child)`. That call is async: it spawns a PowerShell snapshot before it kills anything. The forced-exit paths in `src/status-server/main.ts:21,27,52` call `process.exit()` straight after, so the engine tree (TabbyAPI, about 23 GB of VRAM) is orphaned.

**Files:**
- Modify: `src/lib/process-tree.ts`, `src/status-server/engine-process.ts`, `src/status-server/managed-tabby.ts`, `tests/helpers/in-process-tabby.ts`, `tests/status-server-restart.test.ts` (it implements `EngineProcessLauncher`, so add `terminateSync` there as well)
- Test: `tests/managed-tabby.test.ts`, new `tests/process/exit-tree-kill.test.ts`

- [ ] **Step 1: Write the failing tests.**

  a) In `tests/managed-tabby.test.ts`, after the test `'stopping the engine, or the process-exit path, leaves the RAM disk to the watcher its creation started'`, add a test. Copy the fixture setup from neighbouring tests, e.g. `createManagedTabbyFixture(root, 'managed-tabby-exit-sync')` with `fixture.exl3Preset`.

  ```ts
  test('the process-exit path terminates the engine before it returns', async () => {
    await withTempEnv(async (root) => {
      await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-exit-sync');
      await fixture.runtime.ensurePresetReady(fixture.exl3Preset);
      fixture.runtime.stopForProcessExitSync();
      // Nothing is awaited: an exit handler gets no later turn of the event loop.
      assert.equal(fixture.launcher.events.at(-1), 'terminate-sync');
      assert.equal(fixture.launcher.liveProcessCount, 0);
    });
  });
  ```
  Adjust the setup lines to match how the neighbouring tests prepare the default preset (for example `replaceModelPresets`), if they need it.

  b) Create `tests/process/exit-tree-kill.test.ts`. It is an E2E check that a process which kills its child tree with `terminateProcessTreeSync` and exits at once leaves no descendant alive.

  ```ts
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import { spawnSync } from 'node:child_process';
  import { pathToFileURL } from 'node:url';

  import { isProcessAlive } from '../../src/lib/process-tree.ts';
  import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.ts';

  const ENGINE_SCRIPT = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000);";

  test('an exit handler that kills its child tree synchronously leaves no descendant alive', { skip: process.platform !== 'win32' }, async () => {
    const directory = createManagedTempDir('siftkit-exit-tree-kill-');
    const pids: number[] = [];
    try {
      const driverPath = path.join(directory, 'driver.ts');
      const processTreeUrl = pathToFileURL(path.resolve('src', 'lib', 'process-tree.ts')).href;
      fs.writeFileSync(driverPath, [
        "import { spawn } from 'node:child_process';",
        `import { terminateProcessTreeSync } from ${JSON.stringify(processTreeUrl)};`,
        `const engine = spawn(process.execPath, ['-e', ${JSON.stringify(ENGINE_SCRIPT)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
        "engine.stdout.once('data', (chunk) => {",
        "  process.stdout.write(`${engine.pid} ${String(chunk).trim()}\\n`);",
        '  terminateProcessTreeSync(engine.pid ?? 0);',
        '  process.exit(0);',
        '});',
        '',
      ].join('\n'));
      const driver = spawnSync(process.execPath, [driverPath], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(driver.status, 0, driver.stderr);
      pids.push(...driver.stdout.trim().split(/\s+/u).map(Number));
      assert.equal(pids.length, 2, driver.stdout);
      const deadline = Date.now() + 5_000;
      while (pids.some((pid) => isProcessAlive(pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(pids.filter((pid) => isProcessAlive(pid)), [], 'the engine and its child must be gone once the exit handler returns');
    } finally {
      for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid);
      await removeDirectoryWithRetries(directory);
    }
  });
  ```

- [ ] **Step 2: Run both tests and confirm they fail.** Run `node ./src/test-runner/run-tests.ts managed-tabby` and `node ./src/test-runner/run-tests.ts exit-tree-kill --process`. Expected: FAIL, because `terminateProcessTreeSync` and `'terminate-sync'` do not exist yet.

- [ ] **Step 3: Implement.**

  a) In `src/lib/process-tree.ts`:
  - Change the import to `import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';`.
  - Replace everything from the `TerminateProcessTreeOptions` type down to the end of the file, except `orderDescendantProcessIds`, `isProcessAlive` and the `TOOLHELP_SNAPSHOT_*` constants, which stay as they are. Keep every function's existing doc comment, and shorten any comment longer than 2 lines.

  ```ts
  /** The one spawn shape the snapshot needs; `spawn` satisfies it, and tests pass a real-child spawner. */
  export type SnapshotSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

  export type TerminateProcessTreeOptions = {
    processObject?: { platform: string; kill: (pid: number, signal?: string) => boolean };
    spawnImpl?: SnapshotSpawn;
  };
  type ProcessObject = NonNullable<TerminateProcessTreeOptions['processObject']>;

  const TOOLHELP_SNAPSHOT_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', TOOLHELP_SNAPSHOT_COMMAND];

  // captureToolhelpSnapshot(spawnImpl: SnapshotSpawn): unchanged body, but it passes TOOLHELP_SNAPSHOT_ARGS.

  /** Blocking twin of captureToolhelpSnapshot for exit handlers, which get no later event-loop turn. */
  function captureToolhelpSnapshotSync(): string | null {
    try {
      const result = spawnSync('powershell.exe', TOOLHELP_SNAPSHOT_ARGS,
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: TOOLHELP_SNAPSHOT_TIMEOUT_MS });
      return result.error === undefined && result.status === 0 ? result.stdout.toString('utf8').trim() : null;
    } catch {
      return null;
    }
  }

  function descendantsFromSnapshot(rootPid: number, stdout: string | null): number[] | null {
    if (stdout === null || stdout === '') return null;
    try {
      const snapshot = WindowsProcessSnapshotSchema.safeParse(parseJsonValueText(stdout));
      return snapshot.success ? orderDescendantProcessIds(rootPid, snapshot.data) : null;
    } catch {
      return null;
    }
  }

  export async function listWindowsDescendantPids(rootPid: number, spawnImpl: SnapshotSpawn = spawn): Promise<number[] | null> {
    return descendantsFromSnapshot(rootPid, await captureToolhelpSnapshot(spawnImpl));
  }

  /** Kills the descendants deepest-first, then the root; without a snapshot only the root. */
  function killTree(rootPid: number, descendants: readonly number[] | null, processObject: ProcessObject): boolean {
    let terminated = false;
    for (const pid of [...(descendants ?? []), rootPid]) {
      try {
        if (processObject.kill(pid, 'SIGTERM')) terminated = true;
      } catch {
        // The process already exited; keep terminating the rest of the tree.
      }
    }
    return terminated;
  }

  function toRootPid(pid: number | string): number | null {
    const numericPid = Number(pid);
    return Number.isFinite(numericPid) && numericPid > 0 ? Math.trunc(numericPid) : null;
  }

  export async function terminateProcessTree(pid: number | string, options: TerminateProcessTreeOptions = {}): Promise<boolean> {
    const rootPid = toRootPid(pid);
    if (rootPid === null) return false;
    const processObject = options.processObject ?? process;
    const descendants = processObject.platform === 'win32' ? await listWindowsDescendantPids(rootPid, options.spawnImpl ?? spawn) : [];
    return killTree(rootPid, descendants, processObject);
  }

  /** For exit handlers that cannot await: blocks on the bounded snapshot, then kills the tree. */
  export function terminateProcessTreeSync(pid: number | string, processObject: ProcessObject = process): boolean {
    const rootPid = toRootPid(pid);
    if (rootPid === null) return false;
    const descendants = processObject.platform === 'win32' ? descendantsFromSnapshot(rootPid, captureToolhelpSnapshotSync()) : [];
    return killTree(rootPid, descendants, processObject);
  }
  ```
  - Delete `terminateWindowsTree`; `killTree` replaces it. `isProcessAlive` and anything else unrelated stay where they are.

  b) In `src/status-server/engine-process.ts`, add to `EngineProcessLauncher`:
  ```ts
    /** Blocking tree kill for process-exit handlers, which get no later event-loop turn. */
    terminateSync(engineProcess: EngineProcess): void;
  ```
  Implement it in `ChildProcessEngineLauncher`:
  ```ts
    terminateSync(engineProcess: EngineProcess): void {
      if (engineProcess.pid) terminateProcessTreeSync(engineProcess.pid);
    }
  ```

  c) In `src/status-server/managed-tabby.ts`, change `stopForProcessExitSync` to call `this.host.launcher.terminateSync(child)`, with no `void`.

  d) In `tests/helpers/in-process-tabby.ts`, add `FakeTabbyLauncher.terminateSync`:
  ```ts
    terminateSync(engineProcess: EngineProcess): void {
      this.events.push('terminate-sync');
      for (const process of this.processes) if (process === engineProcess) process.exit(0);
    }
  ```
  Then make the launcher in `tests/status-server-restart.test.ts` implement `terminateSync` in its own style (record or no-op).

- [ ] **Step 4: Run the tests and confirm they pass.** Run the two tests from Step 2, plus `status-server-shutdown`, `start-dev-ports`, `status-server-restart`, `process-priority --process` and `npm run typecheck`.

---

### Task 2: Lease loss is its own job outcome, not a failure string

**Problem:** In `src/assistant/jobs/job-runner.ts` `runClaimed`, a lost lease on `complete` returns `{ kind: 'failed', error: 'Lease lost: …' }`, and a lost lease on `fail` appends a string. The `requeuePreempted` result (now `JobRow | null`) is ignored on all three calls. So lease loss is counted as a job failure and reported only through message text.

**Files:**
- Modify: `packages/contracts/src/assistant.ts:79`, `src/assistant/jobs/job-runner.ts`
- Test: `tests/assistant-job-runner.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - Change the test `'a runner that loses its lease mid-run reports the loss instead of claiming completion'` to assert `result.outcome === 'lease_lost'` and `result.detail === null`. Keep its stored-row assertions.
  - Add a sibling test: `'a runner whose job succeeds after losing its lease reports lease_lost and leaves the live claim alone'`. Use an inference subclass whose `chat(...args: Parameters<ScriptedAgentInference['chat']>)` performs the same lapse, recover and claim steps, then `return super.chat(...args)`. Give it scripted turns that complete the chat job (reuse `NO_OPERATIONS`, or whatever completes a chat job in the existing tests). Assert `outcome === 'lease_lost'`, stored status `'running'` and `lease_owner === 'runner_other'`.
- [ ] **Step 2: Run `node ./src/test-runner/run-tests.ts assistant-job-runner` and confirm it fails.**
- [ ] **Step 3: Implement.**
  - Contracts: change the enum to `z.enum(['completed', 'failed', 'preempted', 'blocked', 'lease_lost'])` and extend its doc comment with "`lease_lost`: another runner owns the job now and its outcome".
  - Runner: add `| { readonly kind: 'lease_lost' }` to `JobRunOutcome`, and `case 'lease_lost': return null;` to `outcomeDetail`.
  - In `runClaimed`:
    - When `complete(...) === null`, return `{ kind: 'lease_lost' }`.
    - When `fail(...) === null`, return `{ kind: 'lease_lost' }`.
    - Check each of the three `requeuePreempted(...)` calls: if it returns `null`, return `{ kind: 'lease_lost' }` instead of `blocked`/`preempted`. For the residency branch, set `shouldRecordGpuUse = false` before returning, as the branch does now.
  - In the drain loop (around line 145), treat `lease_lost` as neither completed nor failed: `else if (outcome.kind === 'lease_lost') continue;` before the `else` branch.
  - Delete the two lease-lost message strings.
- [ ] **Step 4: Run the test file, `assistant-job-store`, any test file that greps for `AssistantRunJobResponse`, and `npm run typecheck`. Confirm all pass.**

---

### Task 3: Every option value is required through one helper

**Problem:** In `src/cli/args.ts`, `parseArguments` checks for a missing value only for `--arg` (added this session) and `--image`. Every other value option silently stores `undefined` when the option is the last token.

**Files:** Modify `src/cli/args.ts`. Test: `tests/cli-command-surface.test.ts`, or whichever test file already covers `parseArguments` (find it with grep).

- [ ] **Step 1: Write the failing test.** For each of `--question`, `--file`, `--op`, `--request-file`, `--preset` and `--max-turns`, assert that `parseArguments([option])` throws `/Missing value for option: <option>/u`. Keep the existing `--arg` assertion, if there is one.
- [ ] **Step 2: Run the test and confirm it fails.**
- [ ] **Step 3: Implement.** Add the helper below, then replace every `tokens[++index]` in `parseArguments` with `readOptionValue(tokens, ++index, token)`. That covers `--max-turns` (drop its `|| ''`) and `--response-format`. Remove the two bespoke `undefined` checks for `--arg` and `--image`.
  ```ts
  function readOptionValue(tokens: readonly string[], index: number, option: string): string {
    const value = tokens[index];
    if (value === undefined) throw new Error(`Missing value for option: ${option}`);
    return value;
  }
  ```
- [ ] **Step 4: Run `cli-command-surface`, `cli-stdin-input`, `cli-input`, the args test and `npm run typecheck`. Confirm all pass.**

---

### Task 4: One child-teardown path in the orchestrator

**Problem:** `startChild`'s catch (`src/orchestrator/run.ts`, around lines 645-652) repeats `superviseChild`'s teardown: abort, then await settled, untrack and `detachWarnings`, plus releasing the repository.

**Files:** Modify `src/orchestrator/run.ts`. Test: `tests/process/orchestrator-run.e2e.test.ts` (existing start-failure coverage).

- [ ] **Step 1: Run the existing coverage.** Run `node ./src/test-runner/run-tests.ts orchestrator-run.e2e --process` and confirm the start-failure scenario passes before the refactor. This is a behaviour-preserving refactor.
- [ ] **Step 2: Implement.** Add:
  ```ts
  /** Hands the repository back and stops observing a child that has settled. */
  private detachChild(child: LiveChild): void {
    child.repository.release();
    this.child = null;
    this.activity.untrack(child.attempt.childRunId);
    child.detachWarnings();
  }
  ```
  - Use it in `superviseChild`'s `finally`, before `this.wake()`.
  - In `startChild`'s catch, replace the `started` branch and the separate `repository.release()` with:
  ```ts
      if (started === null) {
        repository.release();
      } else {
        started.session.abort();
        await Promise.allSettled([started.session.settled]);
        this.detachChild(started);
      }
  ```
  - Remove the now-redundant comment line about release.
- [ ] **Step 3: Run `orchestrator-run.e2e --process`, `orchestrator-plan` and `npm run typecheck`. Confirm all pass.**

---

### Task 5: Process-tree tests use real child processes, not branded fakes

**Problem:** `tests/helpers/process-tree-stubs.ts` uses `z.custom<SpawnImpl>` and `z.custom<ChildProcess>` to brand a plain object as a `ChildProcess`. That is unknown-laundering, which CLAUDE.md forbids. It requires Task 1, which introduces the `SnapshotSpawn` type.

**Files:** Modify `tests/helpers/process-tree-stubs.ts`, `tests/status-server-shutdown.test.ts`, `tests/start-dev-ports.test.ts`.

- [ ] **Step 1: Replace `makeSpawnImpl`.** Replace `SpawnImplSchema`, `SpawnStubChildSchema`, `SpawnStubOutcome` and `makeSpawnImpl` with the code below. Make `STALE_PARENT_SNAPSHOT` a JSON **string**, not a Buffer.
  ```ts
  import { spawn } from 'node:child_process';
  import path from 'node:path';
  import { tmpdir } from 'node:os';
  import type { SnapshotSpawn, TerminateProcessTreeOptions } from '../../src/lib/process-tree.ts';

  /** What the real snapshot child does: print `stdout` after `delayMs` and exit, or fail to spawn at all. */
  export type SpawnStubOutcome =
    | { readonly kind: 'exits'; readonly stdout: string; readonly exitCode: number; readonly delayMs?: number }
    | { readonly kind: 'spawn-error' };

  /** Spawns a real node child per call, so the snapshot code reads a genuine ChildProcess. */
  export function makeSpawnImpl(handler: (file: string, args: readonly string[]) => SpawnStubOutcome): SnapshotSpawn {
    return (file, args, options) => {
      const outcome = handler(file, args);
      if (outcome.kind === 'spawn-error') return spawn(path.join(tmpdir(), 'siftkit-missing-snapshot-exe.exe'), [], options);
      const script = `setTimeout(() => { process.stdout.write(${JSON.stringify(outcome.stdout)}); process.exitCode = ${outcome.exitCode}; }, ${outcome.delayMs ?? 0});`;
      return spawn(process.execPath, ['-e', script], options);
    };
  }
  ```
  Remove the `z` import if nothing else uses it.
- [ ] **Step 2: Update the callers.**
  - Calls such as `{ stdout: STALE_PARENT_SNAPSHOT, exitCode: 0 }` become `{ kind: 'exits', stdout: STALE_PARENT_SNAPSHOT, exitCode: 0 }`.
  - The nonzero case becomes `{ kind: 'exits', stdout: '', exitCode: 1 }`.
  - The errored case becomes `{ kind: 'spawn-error' }`.
  - The thrown case still throws inside the handler.
  - The event-loop test keeps `delayMs: 250`.
  - Keep every assertion unchanged.
- [ ] **Step 3: Run `status-server-shutdown`, `start-dev-ports` and `npm run typecheck`. Confirm all pass.** Then run `grep -rn "z.custom" tests/helpers/process-tree-stubs.ts`, which must print nothing.

---

### Task 6: New tests reuse the existing package.json reader

**Problem:** `tests/readme-command-surface.test.ts`, `tests/script-typecheck-coverage.test.ts` and `tests/verify-client-script.test.ts` each declare their own `PackageJsonSchema` and parse `package.json`. `tests/helpers/package-json.ts` already exports `readPackageJson()`.

- [ ] **Step 1:** In all three files, delete the local `PackageJsonSchema`, then replace each `fs.readFileSync(...package.json...)` + `JSON.parse` + parse block with `readPackageJson().scripts`. Drop the now-unused `z` imports.
- [ ] **Step 2: Run the three test files and `npm run typecheck`. Confirm all pass.**

---

### Task 7: Use Node's glob matcher instead of a hand-rolled one

**Problem:** `tests/script-typecheck-coverage.test.ts:32` hand-builds a glob-to-regex matcher, `includeEntryMatches`. Node 26 ships `path.matchesGlob`.

- [ ] **Step 1:** Delete `includeEntryMatches`. Match with `path.posix.matchesGlob(relativePath, entry)`; this also covers literal entries, since a literal pattern matches only itself. Keep all three tests and their assertions.
- [ ] **Step 2: Run `script-typecheck-coverage` and `npm run typecheck`. Confirm both pass.**

---

### Task 8: One wipe predicate for inference runs and their engine events

**Problem:**
- `src/state/engine-events.ts` `deleteEngineEventsForInferenceRunsOlderThan` copies the inference-run wipe predicate, `status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?`. That predicate already appears in two SQL strings in `AUX_RUN_HISTORY_DELETE_STATEMENTS` (`src/status-server/dashboard-runs/deletion.ts:201-202`).
- A change to one copy silently orphans events.

**Files:** Modify `src/status-server/dashboard-runs/deletion.ts` and `src/state/engine-events.ts`. Test: `tests/dashboard-runs-partition.test.ts` (existing engine-events wipe coverage).

- [ ] **Step 1: Implement.**
  - In `deletion.ts`, add `const INFERENCE_RUN_WIPE_WHERE = "status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?";`.
  - Use it, via template strings, in both inference_runs AUX statements.
  - Add `const ENGINE_EVENTS_WIPE_SQL = \`DELETE FROM engine_events WHERE inference_run_id IN (SELECT id FROM inference_runs WHERE ${INFERENCE_RUN_WIPE_WHERE})\`;`.
  - Replace the `deleteEngineEventsForInferenceRunsOlderThan(database, cutoff)` call with `database.prepare(ENGINE_EVENTS_WIPE_SQL).run(cutoff);`, keeping the comment above it.
  - Delete `deleteEngineEventsForInferenceRunsOlderThan` from `engine-events.ts` and its import.
- [ ] **Step 2: Run `dashboard-runs-partition`, `inference-runs` and `npm run typecheck`. Confirm all pass.**

---

### Task 9: Job-store terminal writes share one statement

**Problem:** `JobStore.cancel` (`src/assistant/storage/job-store.ts`) now carries a copy of `setTerminal`'s UPDATE, minus the lease fence.

- [ ] **Step 1: Implement.**
  - Add a module constant:
  ```ts
  const SET_TERMINAL_SQL = `
    UPDATE assistant_jobs
    SET status = ?, lease_owner = NULL, lease_expires_at_utc = NULL, last_error = ?, updated_at_utc = ?
    WHERE id = ?`;
  ```
  - `cancel` runs `this.database.prepare(SET_TERMINAL_SQL).run('cancelled', null, this.clock.nowUtc(), jobId)`.
  - `setTerminal` runs `this.database.prepare(\`${SET_TERMINAL_SQL} AND lease_owner = ?\`).run(status, errorMessage, this.clock.nowUtc(), jobId, leaseOwner)`.
  - Keep both doc comments.
- [ ] **Step 2: Run `assistant-job-store`, `assistant-job-runner` and `npm run typecheck`. Confirm all pass.**

---

### Task 10: A plain comparator for the non-code directory sort

**Problem:** `src/repo-search/prompts.ts:132` uses a nested-ternary comparator plus a comment to avoid a `!`.

**Files:** Modify `src/repo-search/prompts.ts`. Test: `tests/repo-file-listing.test.ts`.

- [ ] **Step 1: Write a pinning test.** In `tests/repo-file-listing.test.ts`, following the existing `scanRepoFiles(root, buildIgnorePolicy(root))` setup, create the non-code files `B/x.md` and `a/y.md`. Assert that the `B/` summary line comes before the `a/` line: byte order, where uppercase sorts first. Run it and confirm it passes on the current code.
- [ ] **Step 2: Implement.** Replace the comment and the comparator line with:
  ```ts
  // Map keys are unique, so byte order needs no equal case.
  const sortedEntries = [...aggregated].sort(([left], [right]) => (left < right ? -1 : 1));
  ```
- [ ] **Step 3: Run `repo-file-listing` and `npm run typecheck`. Confirm both pass.**

---

### Task 11: Drop the redundant deleted-script test

**Problem:** In `tests/readme-command-surface.test.ts`, the test `'neither document references the deleted verify:llama-live script'` pins a deleted name. `'every documented npm run script exists in package.json'` already catches any reference to a missing script.

- [ ] **Step 1:** Delete that test. Keep the `ALLOWED_PATHS` entry in `tests/process/no-llama-references.test.ts`, because `DOC_FILES` still names `eval/llama-spec-prompt.txt`.
- [ ] **Step 2: Run `readme-command-surface` and `no-llama-references --process`. Confirm both pass.**

---

### Task 12: One cohesive permission-error scenario for both capture paths

**Problem:** `tests/process/command.test.ts` has two near-identical tests: `invokeProcess …` and `captureWithTranscript …`. Each repeats the same `spawnSync` EPERM probe.

- [ ] **Step 1:**
  - Move the probe into `withDeniedFile`, right after the deny succeeds: `assert.match(spawnSync(...).error?.message ?? '', /EPERM|EACCES/u)`.
  - Merge the two tests into one, `'both capture paths surface a permission error without re-running through a shell'`. Use one temp dir and one `withDeniedFile` call; inside the callback, assert the `invokeProcess` result and then the `captureWithTranscript` result, keeping every existing assertion.
- [ ] **Step 2: Run `command --process`. Confirm it passes.**

---

### Task 13: Straight-line stale recovery-claim check

**Problem:** `clearStaleRecoveryClaim` in `src/repo-agent/run-state-lease.ts` uses two try/catch blocks with `undefined` sentinels. It also spells out a multi-line inline `z.infer<...>` type.

- [ ] **Step 1: Implement.** Add `type RepoAgentRunStateLeaseOwner = z.infer<typeof RepoAgentRunStateLeaseOwnerSchema>;` and use it as `readOwner`'s return type. Then replace `clearStaleRecoveryClaim`, keeping its two-line comment:
  ```ts
  private clearStaleRecoveryClaim(): boolean {
    const owner = this.tryReadOwner(this.recoveryPath);
    if (owner !== null) {
      if (this.processInspector.isAlive(owner.pid)) return false;
    } else if (this.claimAgeMs(this.recoveryPath) < STALE_RECOVERY_CLAIM_MS) {
      return false; // A fresh unreadable claim may still be mid-write.
    }
    rmSync(this.recoveryPath, { force: true });
    return true;
  }

  private tryReadOwner(filePath: string): RepoAgentRunStateLeaseOwner | null {
    try {
      return this.readOwner(filePath);
    } catch {
      return null;
    }
  }

  /** Infinity once the claim has vanished, so the caller's retry recreates it. */
  private claimAgeMs(filePath: string): number {
    const stat = statSync(filePath, { throwIfNoEntry: false });
    return stat === undefined ? Number.POSITIVE_INFINITY : Date.now() - stat.mtimeMs;
  }
  ```
- [ ] **Step 2: Run `repo-agent-run-state-lease` and `npm run typecheck`. Confirm both pass.**
