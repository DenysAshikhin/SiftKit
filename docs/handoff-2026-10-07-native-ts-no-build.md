# Handoff 2026-10-07: native TypeScript, no build steps

## Status

**Done and verified, not committed** (the user's rule is no commits unless asked). Everything is uncommitted on `main` (about 1,300 entries).

- **Goal:** the user replaced Node 24 with Node 26 (v26.7.0), which runs `.ts` natively. They asked to remove every build step that compiles TypeScript.
- **Plan:** `docs/superpowers/plans/2026-10-07-native-ts-no-build.md`. Tasks 0–10 are all executed. A few deviations are noted below.
- **User decisions:**
  - The global CLI is installed as a link to the repo.
  - The dashboard keeps its Vite build.
  - Dashboard tests move to Vitest.
  - Type checks must still block the build and every test command.
  - Comments stay at 1–2 lines.
  - Do not use SiftKit tools in this session.

## What changed

**Making the sources runnable by Node**
- All relative imports point at `.ts`/`.tsx` files, about 7.1k specifiers rewritten.
  - `dashboard/src` imports now carry explicit extensions too, so its non-JSX modules are runnable by Node.
- 426 constructor parameter properties (`private readonly x: T` in constructors) became explicit fields, because Node rejects that syntax.
- Root `package.json` is `"type": "module"` with `"engines": {"node": ">=26"}`. The nested `src/`, `scripts/` and `bench/` `package.json` files were deleted.

**TypeScript configs**
- All tsconfigs are `noEmit`.
- Root and dashboard configs add `allowImportingTsExtensions`, `erasableSyntaxOnly` and `verbatimModuleSyntax`, so Node-incompatible syntax fails typecheck.
- `packages/contracts` exports `./src/index.ts`; it has no build and no `dist`.
- `tests/relative-import-specifiers.test.ts` fails if any relative import doesn't name an existing file.

**Entry points**
- `bin`, `bin/siftkit.{cmd,ps1}`, `SiftKit/SiftKit.psm1`, `scripts/verify-client.ps1` and `scripts/invoke-repo-search-benchmark.cjs` all point at `src/cli/main.ts`, which has a shebang (`tests/cli-shebang.test.ts`).
- The desktop shell's default daemon (`desktop/src-tauri/src/main.rs`) is `src/status-server/main.ts`.
- The flush worker resolves to its sibling `.ts` file.
- `install.ts` no longer copies `dist`.

**Scripts**
- `tsx`/`nodemon` are replaced by `node`; `start:status` uses `node --watch --watch-kill-signal SIGINT`.
- `build` = `tsc -p tsconfig.json && tsc -p packages/contracts && node scripts/dashboard-stamp.ts`, which runs the Vite build.
- `test`, `test:process` and `test:perf` run `tsc -p tsconfig.test.json` first, then `node src/test-runner/run-tests.ts`.
- `test:dashboard` = `tsc -p dashboard/tsconfig.test.json && vitest run --config dashboard/vitest.config.ts`. Vitest is a root devDependency; it runs from the repo root because the tests assume that as the working directory.

**Test runner**
- `src/test-runner/test-targets.ts` scans `tests/**/*.test.ts`. Suites:
  - `node`: the top level of `tests/`, which is the default run.
  - `--process`
  - `--perf`
- The guard preload (`live-instance-guard.ts`) and `tests/helpers/hermetic-fs.ts` load as `.ts`.

**Tests**
- The 6 root tests that import `.tsx` moved into `dashboard/tests/`:
  - `dashboard-app-refresh`
  - `dashboard-benchmark-controller`
  - `dashboard-model-presets-section`
  - `dashboard-presets-section`
  - `dashboard-runs-controller-e2e`
  - `dashboard-settings-controller`
- `dashboard/tests` was ported from `node:test` to Vitest:
  - `t.after` → `onTestFinished`
  - `t.mock.method` → `vi.spyOn`
  - `t.mock.timers` → `vi.useFakeTimers`
  - `t.signal` → the `({ signal })` test context
- Root tests that import only `.ts` dashboard modules still run on `node:test`.

**Global install**
- `scripts/refresh-global.ps1` installs with `npm i -g <repoRoot>`, which creates a junction. Node refuses to strip types under `node_modules`, but the junction resolves to the repo, so the sources run.
- The tarball pack/install flow, the bundled-dependencies (`bundleDependencies`) setting and the "stop global status server" step were removed. The link install overwrites no files a running server holds, and matching the repo path would kill `npm start`.

**Deleted**
- Scripts and configs:
  - `scripts/build-test.ts`
  - `scripts/sync-dist-runtime.ts`
  - `src/test-runner/test-build-state.ts`
  - `tsconfig.test-build.json`
- Tests of the old pipeline:
  - `tests/test-build-state.test.ts`
  - `tests/test-build-artifacts.test.ts`
  - `tests/package-artifact.test.ts`
  - `tests/package-files.test.ts`
  - `tests/sync-dist-runtime-shebang.test.ts`
  - `tests/process/test-targets.test.ts`
- Generated output: `dist/`, `packages/contracts/dist/`, `.test-build/`.
- From `.gitignore`: `dist`, `.test-build` and `*.tgz`.

**Docs:** `README.md` (install/build/test section and the `refresh-global` line) and `docs/web-chat-recovery.md`.

## Verification (final run)

| Command | Result |
|---|---|
| `npm test` | 4178 tests, 0 fail, 4 skipped (54s including tsc) |
| `npm run test:dashboard` | 625/625 (matches the pre-migration 609 dashboard + 16 moved) |
| `npm run test:process` | 229 pass, 2 fail — both fail identically at baseline (see open items) |
| `npm run test:perf` | pass |
| `npm run typecheck` (includes lint) | clean |
| `npm run desktop:test` | pass |
| `npm run build` | pass |
| `npm run refresh-global` | pass: global `node_modules\siftkit` is a junction to the repo; PowerShell, cmd and Git Bash smoke and quote round-trips pass |

Type gates were proven by injecting a type error into `src`, `tests` and `dashboard/tests`. `build`, `test` and `test:dashboard` each exited 2 before running any test.

## Open items / gotchas

1. **Dependency upgrades Node 26 forced:**
   - `better-sqlite3` ^12.11.1 ships a Node 26 (ABI 147) prebuild, so the earlier hand-built binary is gone and `npm rebuild` is safe.
   - `c8` ^12: c8 11's `yargs` 17 crashes on Node 26, which broke `test:coverage` and `scripts/analysis/*`.
2. **Two process tests that failed before the migration are fixed:**
   - The wheel-command test now pins `C:\AI\exl3\dev-20261006\src`, the source `docs/exl3-backend-setup.md` records.
   - The `SQLITE_BUSY` test now expects narration rows as `assistant_narration`.
3. **Browser test pages bundle through Vite's `build({ write: false })`** in `tests/helpers/browser-page.ts`; `esbuild` is no longer a direct devDependency.
4. **`dashboard/tsconfig.test.json` still excludes 17 test files from typecheck.** This is pre-existing type debt, untouched.
5. **The global `siftkit` now runs from the working tree;** a broken checkout breaks the global CLI.
6. **Leftover for the user to delete:** `C:\tmp\rsx\ts-probe\` and `C:\tmp\rsx\err-tsconfig.*.txt` (the safety check blocked deleting them).
7. **`Install-SiftKitShellIntegration` installs a manifest, not a copy.** Its `RootModule` is this checkout's `SiftKit.psm1`, so the module and `bin\siftkit.ps1` both resolve this repo's CLI.
8. **`tests/SiftKit.Tests.ps1` (Pester) passes 14/14.** It runs from a temp root outside the repo and drives the node suite's stub through `tests/fixtures/stub-status-server-process.ts`. Run it with `Invoke-Pester -Script .\tests\SiftKit.Tests.ps1`; no npm script runs it.
9. **`scripts/analysis/coverage-isolation-runner.ts` spawns a bare `node --test`,** without the live-instance guard or hermetic filesystem that `npm test` adds. It already did this before the migration.
10. **Unrelated uncommitted user work is present; leave it alone:**
   - `docs/exl3-backend-setup.md`
   - `docs/analysis/*`
   - `docs/superpowers/plans/2026-09-29-*` and `2026-10-06-*`

## Suggested next steps

- Review the diff and commit if the user asks (this handoff and the plan doc are new files too).
- Optionally trim the `dashboard/tsconfig.test.json` exclude list.
