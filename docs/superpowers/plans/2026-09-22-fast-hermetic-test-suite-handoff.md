# Fast, hermetic test suite — handoff (v2)

The user paused the session on 2026-09-22. This document replaces the v1 handoff. Nothing is committed. The user's rule is never commit unless asked.

## 1. User requirements

1. `npm test` should finish in **under 30 s** without losing coverage or test quality. Do not raise `DEFAULT_TEST_CONCURRENCY` (12, in `src/test-runner/test-targets.ts`).
2. **Do not use SiftKit** for this task. This overrides the global SiftKit-first and repo-agent rules. Starting and stopping the local server is fine.
3. **Hermetic default suite.**
   - No real Tabby/Python, git, powershell, or taskkill.
   - No child node processes.
   - No real database files. Runtime SQLite is **fully in memory** (the user chose this after seeing data).
   - Loopback stub HTTP servers are allowed.
   - Tests of real process behaviour live in the opt-in `npm run test:process` suite (`tests/process/**`). Never delete or weaken them.
4. **No real folders or files.** The user said: "something closer to fully in-memory filesystem … just some mockups". Temp-dir file activity is served from memory, and writes outside the OS temp dir fail the test file.
5. The global CLAUDE.md rules apply:
   - TypeScript only, no `any`, casts, `!`, explicit `unknown`, or namespace imports.
   - Zod-validated IO.
   - TDD.
   - Complete refactors with no shims.
   - Comments of 1–2 lines.
   - Run typecheck and lint before calling anything done.
   - Scratch files go in `.tmp/perf/`, deleted at the end.
6. Leave these alone:
   - Untracked plan docs `2026-09-22-{measured-idle-context-usage,persistent-live-status,webui-chat-tools-and-fixes,webui-unbounded-model-queue-wait}.md`.
   - Node PIDs 40336, 39868, and 40204, which belong to Codex.

## 2. Architecture now in the working tree

### Hermetic mode
- Set in `src/test-runner/live-instance-guard.ts`, which is preloaded through `NODE_OPTIONS` by `run-tests.ts`.
- It applies when `NODE_TEST_CONTEXT` is set and `SIFTKIT_GUARD_SPAWN_ALLOWED !== '1'`.
- If `argv[1]` is under `/tests/process/`, the guard sets `SIFTKIT_GUARD_SPAWN_ALLOWED=1` and descendants inherit it.
- Otherwise the guard:
  - sets `SIFTKIT_RUNTIME_DATABASE_STORAGE=memory`;
  - dynamically imports the hermetic-fs bundle from env `SIFTKIT_GUARD_HERMETIC_FS`, which `run-tests.ts` sets to the URL of `.test-build/hermetic-fs.bundle.js`;
  - replaces every `child_process` spawn API with throwing, violation-recording proxies, then calls `syncBuiltinESMExports()`;
  - on exit prints `CHILD PROCESS STARTED` and sets exit code 1.
- The guard may statically import only `node:` builtins. Env values are read by `readGuardEnv(name, purpose)`.

### `tests/helpers/hermetic-fs.ts`
- Moved here from `src/test-runner/`, so no copy lands in `dist/`.
- Built on memfs 4.79 (a devDependency). `build-test` bundles it with memfs inlined.
- `os.tmpdir()` paths map to `/tmp` in a memfs Volume. Reads elsewhere hit the real disk.
- Writes elsewhere throw and are reported at exit as `FILE WRITTEN OUTSIDE THE TEMP DIRECTORY`.
- Virtual fds start at 0x40000000. `chdir`/`cwd` are virtualized. Promise APIs and FileHandles yield through `setImmediate`. Copies from real to virtual are cross-copied.
- The process entrypoint (`argv[1]`) is always real, even under tmpdir. This was added for the guard-test probes.

### In-memory runtime DB (`src/state/runtime-db.ts`)
- A per-path registry serializes the database into `memoryImages` on close and deserializes it on reopen. A file seeded on disk is loaded when no image exists.
- New exports:
  - `getRuntimeDatabaseStorage`
  - `runtimeDatabaseExists`
  - `isRuntimeDatabaseOpen`
  - `getRuntimeDatabaseFilePath`
  - `readRuntimeDatabaseImage`
  - `writeRuntimeDatabaseImage`
- All direct `new Database(path)` sites now go through the registry: server-ops idle summary, dashboard-runs queries, line-read-guidance, dashboard route. `chat-run-recorder` uses `getRuntimeDatabaseFilePath`.
- The flush queue uses `InProcessFlushWriter` (`src/status-server/inference-run-flush-writer.ts`) in memory mode. `FlushWorkerPort` listener methods return `this`.

### Other seams
- **Config:** `src/config/paths.ts` has a pure `getRuntimePaths()`. `initializeRuntime()` still mkdirs, and is used only where directories are truly needed.
- **DPAPI:** a `DataProtector` is injected into the backup/restore services.
- **Engine:** the `EngineProcess`/launcher seam lives in `src/status-server/engine-process.ts` (untracked file, part of this work).
- **Test helpers:**
  - `tests/helpers/in-process-tabby.ts` and `tabby-fake.ts` provide a fake Tabby.
  - `stored-runtime-database.ts` and `runtime-database-probe.ts` help tests read and write in-memory DBs.

### Test build (`scripts/build-test.ts`)
- esbuild no longer uses `packages: 'external'`.
- The `externalize-unbundled-packages` plugin inlines `BUNDLED_PACKAGES = zod, undici, @siftkit/contracts, jsonrepair, turndown, memfs` plus their transitive deps. The rule is that importers under `node_modules` resolve normally.
- Every other bare specifier stays external: better-sqlite3, jsdom, vite, typescript, and so on.
- The banner adds `createRequire` for the bundled CJS.
- `HERMETIC_FS_BUNDLE_PATH` is exported from `src/test-runner/test-build-state.ts` and listed in `STATIC_OUTPUT_PATHS`.
- Tried and **rejected** (both slower or no gain):
  - `splitting: true`: 19–23 s floor against 15 s.
  - `NODE_COMPILE_CACHE`: no gain.
  - Largest-bundle-first ordering: no gain.

### Process suite
- `npm run test:process` runs `tests/process/**`.
- Moved whole files:
  - `dashboard-vite-config`
  - `inference-run-flush-worker`
  - `assistant-backup-restore`: restored to file-based snapshot editing (`new Database(snapshotPath)`), because WAL snapshot buffers can't be deserialized.
  - `assistant-gate-e-routes`
  - `runtime-db-schema`
  - `live-instance-guard`
  - plus earlier moves
- Individual tests were split out of these files, with shared helpers in `tests/helpers/*-fixtures.ts`:
  - chat-recovery-storage-faults
  - chat-run-recorder
  - inference-run-flush-queue
  - runtime-db-lifecycle
  - config initializeRuntime
  - test-targets
  - runtime-helper-modules
  - assistant-gate-e-e2e scenario 12

## 3. Changes in this last segment

- **`tests/process/live-instance-guard.test.ts`** gained three hermetic-fs tests:
  - a default-suite file keeps its temp files in memory, so the directory doesn't exist on disk afterwards;
  - a write outside tmp fails the file even when the throw is swallowed;
  - a process-suite file writes real temp files.
  - The file also got a `zod` import. The probe uses `mkdirSync` with a pid-named directory, because the hygiene gate forbids `mkdtempSync` outside the registry.
- **`tests/test-build-artifacts.test.ts`:** the source-grep for `external: true` was replaced with a behavioural test. It checks that `test-build-state.test.bundle.js` imports only builtins and packages (no relative or absolute paths) and has no `zod` import. The `preserveLocationDependentModules` grep stays.
- **`tests/test-build-state.test.ts`:** `REQUIRED_OUTPUT_FILES` includes `.test-build/hermetic-fs.bundle.js`.
- **Lint fixes:** `unknown` return types changed to `this` in `engine-process.ts` (`once`) and `inference-run-flush-writer.ts` (`on`/`off`).
- **Speed fixes in test bodies** (only cadence changes; the assertions are unchanged):
  - `status-server-chat-operation-attach`: the per-frame `setTimeout(2)` became `setImmediate`. 8.9 s → 0.77 s.
  - `managed-tabby` fixture preset: `HealthcheckIntervalMs: 10`. The default is 1000. About 9 s → 1 s.
  - `managed-tabby-run-history` preset: same change. 3.3 s → 0.2 s.
  - `inference-passthrough-idle`: added to its 3 presets. That file still takes about 2.4 s because it genuinely waits `SleepIdleSeconds: 1`.

## 4. Verification status (be precise)

**Passed:**
- `npm run test:process`: 216 pass, 0 fail, 1 skipped, about 62 s.
  - This was run **before** the build-test bundling change and the hermetic-fs move, but after the backup-restore fix.
  - `chat-recovery-performance` "RSS budget 192 MiB" is a known near-limit flake (190–192.4 MiB). Don't loosen the budget; report it.
- `npm run typecheck` and `npm run lint`: exit 0, after the lint fixes and **before** the bundling, hermetic-fs move, and speed edits.
- Last full `npm test`: **42.5 s** wall, 4070 tests. It had 5 failures: the build-artifact and build-state tests, now fixed and passing in a focused run (17/17). That run came **before** the attach, managed-tabby, and run-history speedups.
- Focused runs passed: attach (6/6), managed-tabby (12/12), managed-tabby-run-history plus inference-passthrough-idle (5/5).

**Not yet verified:**
- Full `npm test` after the last edits. My final attempt was interrupted.
- Full `npm run test:process` after the hermetic-fs move and bundling change. Must run: the guard tests depend on `SIFTKIT_GUARD_HERMETIC_FS` being inherited from the runner env.
- `npm run typecheck` and `npm run lint` after the latest edits: `scripts/build-test.ts` (esbuild `Plugin` type, the regex `filter: /^[^./]/` without `u` because esbuild rejects Go-incompatible flags; lint may complain), the moved `tests/helpers/hermetic-fs.ts` (which uses a `Function` type), `run-tests.ts`, and the guard.

## 5. Where time goes now

- **Startup floor** (all 476 files loaded, zero tests run with `--test-name-pattern=ZZZ_NO_MATCH_ZZZ`): **15 s** wall.
  - It started this segment at 26 s. Bundling packages took it to about 18 s, and bundling memfs to 15 s.
  - Floor CPU is about 185 s:
    - zod top-level schema construction: about 50 s (`$constructor`/`init`, about 85 ms per process, inherent to zod v4 classic);
    - ESM compile of the bundles: about 28 s;
    - GC: about 19 s;
    - node builtin bootstrap: about 11 s;
    - memfs CJS init: about 8 ms per file.
- **Test bodies:** about 230 s summed at 42.5 s wall. The speedups above should have removed roughly 20 s summed.
- Remaining slow tests, ≥1 s each:
  - `isolated-runtime` close-retry: 4.2 s
  - `chat-projection-updates` linear traffic: 4.0 s
  - `chat-recovery-performance` incident journal: 2.6 s
  - `inference-passthrough-status-server` abort: 2.3 s (the file has a `setTimeout(2000)` at line ~499)
  - `status-server-shutdown-cleanup`: 2.1 s (`delay(250)`)
  - `model-request-queue-http` ParallelSlots tests: about 1.7 s each
  - `dashboard-chat-concurrency`: about 1.4 s each
  - `status-server-chat-stop`: about 1.3 s each (`delay(500)` race)
  - `chat-history-import` repair tests: about 1.1–1.5 s each
  - `runtime-planner-mode`: about 1.4 s
  - `model-request-queue` idle tests (`SleepIdleSeconds: 1`, genuine waits)
  - `sse-response-writer`: 1.7 s (`setTimeout(150)`)
  - `live-run-snapshot-execute`: 1.5 s
- **Next speed ideas:**
  1. Look for other presets built from `getDefaultConfigObject()` without a `HealthcheckIntervalMs` override. The 1000 ms default poll adds about 1 s per engine start.
  2. Check whether `SleepIdleSeconds` accepts fractions (contracts schema is `z.number()`; check normalization) so idle tests can use 0.05.
  3. Convert fixed sleeps to event waits.
  4. Profile the slow individual tests.
  5. zod: consider lazy schema construction in the heaviest modules (`src/assistant/domain/proposal-schema.ts` is about 4.4 s CPU across the suite, then `planner-protocol/json-schema.ts` and `repo-search/planner-protocol.ts`). This is invasive, so ask the user first.
  6. Earlier ideas: `mergeConfig` type guard instead of zod `asObject`, and avoiding a full config parse per drain waiter.
- **Don't use a setTimeout-wrapping preload for diagnostics.** `.tmp/perf/timerdiag.mjs` hung the suite.

## 6. Housekeeping for the next agent

- **Orphaned processes:** two node test processes were left by the aborted timer-diagnostic run. Their command lines contain `timerdiag.mjs` and `dashboard-chat-concurrency.test.js`, and they were PIDs 38728 and 29720 at pause. The auto-mode classifier denied killing them. Ask the user to end them, or check whether they exited. They are not Codex's.
- `.tmp/perf/`: scratch space, git-ignored. Delete it when the task is complete. Useful scripts:
  - `reporter.mjs` + `agg.mjs`: per-file timing. Pass the reporter as `file:///<cygpath -m abs>/.tmp/perf/reporter.mjs`.
  - `aggprof.mjs`: multi-profile CPU aggregation.
  - `zodsrc.mjs`, `zodfn.mjs`: zod and hot-function attribution.
  - `edit-lib.cjs`: literal replacement.
  - Avoid bash heredocs containing backslashes or `\n`; they get mangled. Use the Edit tool.
- `.tmp/perf/build-test.bak.ts` and `tt.bak.js` are old backups. `dist/test-runner/test-targets.js` was restored from `tt.bak.js`; a `npm run build:test` regenerates it anyway.
- The v1 content of this doc (WIP M4-C1 repair details and the roadmap) is superseded. The M4-C1 repair is still uncommitted in the tree, and `2026-09-22-model-routing-orchestration-handoff.md` still needs its M4-C1 status updated when committing.

## 6b. Segment 3 (2026-09-22, later session)

- **Verified first:** full default suite 4067 pass at 36.2 s. Process suite 216 pass / 1 skip. Typecheck and lint green. The orphaned processes were gone.
- **Lingering-timer fixes** (processes that stayed alive after their last test):
  - `model-request-queue`: `t.mock.method(globalThis, 'clearTimeout')` over mock timers. The test tracker's end-of-test `restoreAll` put the *mocked* `clearTimeout` back, so every later `clearTimeout` in the file was a no-op. Now it uses the module `mock` tracker, restores the spy before the timers, and has a regression assertion. 13.4 s → ~5 s.
  - `dashboard-runs-controller-e2e`: `dom.window.close()` clears the 9 s toast timer. Note that `useToasts` never clears its timers on unmount.
  - `status-server-chat-stop` race delays, and the `repo-search`/`runtime-summarize`/`_runtime-helpers` stub-server holds, are now unref'd.
- **Suite is CPU-bound** (~10.3 of 12 cores busy), so file ordering does not help. Longest-first was measured and gave no gain.
- **CPU fixes:**
  - `mergeConfig`/`getRecord` use the `isJsonObject` guard instead of `asObject` deep re-parse. That re-parse was O(size×depth) and cost ~25 s CPU. `normalizeConfigObject` still ends in `CanonicalSiftConfigSchema.parse`.
  - `buildChatMessageId`/`buildChatRunMessageIdPrefix` hoist their schema (~4.6 s CPU).
- **Result:** 28.7–34.1 s over 8 runs, median ~30.6 s, with heavy background apps running. Validation is green.
- **Flake:** one silent file-level exit of `status-server-chat-repo-agent` in 1 of ~12 runs (35 tests missing, no error text). It was not reproduced with an exit-code preload across 7+ runs.
- **Remaining CPU (after fixes):** load ~117 s (zod top-level ~42 s, ESM compile ~22 s); run ~131 s. Run-time items:
  - runtime-db schema init: 9.4 s
  - `canonicalDatabaseKey` realpath via hermetic-fs: ~3.5 s
  - `readConfig`/normalize per drain: ~10–12 s
  - `test-targets` manifest hashing per call: 4.6 s
  - `proposal-schema` load: ~4 s (ask first)
- Scripts in `.tmp/perf/`: `fired.mjs` (timers that actually fire), `handles.mjs` (live timers at T), `cpu.mjs`/`life2.mjs` (per-process CPU and lifetime), `split.mjs` (load vs run), `zodcallers.mjs`, `parents.mjs`, `under.mjs`, `loadself.mjs`.

## 7. First actions

1. Confirm the orphaned processes are gone.
2. `npm run build:test`, then:
   - `node ./dist/test-runner/run-tests.js` (full default suite)
   - `node ./dist/test-runner/run-tests.js --process`
   - `npm run typecheck`
   - `npm run lint`
3. Fix anything red. Treat `chat-recovery-performance` RSS as a known flake. Do not loosen it.
4. Measure wall time. If it is above 30 s, continue with §5's ideas, measuring the floor and the full run after each change.
5. At completion:
   - report the result, changed files, validation, and risks;
   - delete `.tmp/perf/`;
   - ask the user about commits (suggested split: M4-C1 repair / hermetic seams + process suite / in-memory DB + hermetic fs / build bundling + speedups).
