# Incremental build pipeline + desktop steps in refresh-global

Date: 2026-08-28
Status: Approved

## Goal

Every build layer skips unchanged work, and `npm run refresh-global` also provisions the
Rust toolchain (when missing) and builds the desktop shell:

- TypeScript: per-file incremental emit via `tsc -b` project references.
- Dashboard: Vite production build skipped entirely when its inputs are unchanged
  (content stamp; Vite cannot do per-file incremental production builds).
- Desktop shell: `cargo tauri build` (cargo is natively incremental).
- Runtime output layout is unchanged: `dist/cli/main.js`, `dist/status-server/main.js`,
  and the packed tarball contents stay exactly where they are today.

## Background

Today `npm run build` runs `sync-dist-runtime --clean` (deletes `dist/` wholesale), then
`tsc -p tsconfig.json` + `tsc -p tsconfig.scripts.json`, then a post-build move that
flattens `dist/src/*` → `dist/*`. The flatten exists only because `tsconfig.json` maps
`@siftkit/contracts` to the package's **source** (`./packages/contracts/src/index.ts`),
pulling `packages/` into the program and raising the common rootDir. The wipe + move make
tsc incrementality impossible: a `.tsbuildinfo` would describe outputs that no longer
exist at their emitted paths.

`packages/contracts/tsconfig.json` is already `composite: true` with `declaration`,
`declarationMap`, `rootDir: ./src`, `outDir: ./dist` — a valid project-reference target
that the root simply never referenced.

## Design

### 1. TypeScript: project references

`tsconfig.json`:

- Remove the `paths` mapping for `@siftkit/contracts`.
- Add `references: [{ "path": "./packages/contracts" }]`.
- Add `rootDir: "src"`, `incremental: true`,
  `tsBuildInfoFile: ".tscache/main-build.tsbuildinfo"`. The root is **not** made
  `composite` — only referenced projects need it, and five other configs `extends` the
  root; inherited `composite` would conflict with their `noEmit`.
- Emit goes directly and flat to `dist/` (cli/, status-server/, …); no `dist/src`
  staging directory is ever created.

Contracts resolution: `@siftkit/contracts` resolves through the workspace symlink to
`packages/contracts/dist` (its `exports` map). `tsc -b` builds contracts first and only
when its sources changed. `declarationMap` keeps go-to-definition landing on contracts
source.

`tsconfig.scripts.json`:

- Becomes typecheck-only: `noEmit: true`, drop `outDir`/`rootDir`, add
  `incremental` + `.tscache/scripts.tsbuildinfo`.
- This kills the duplicate `dist/src/**` emit that pass produced (its `rootDir: "."`
  include of `src/` deps emitted a second copy of shared modules).
- The only live consumer of `dist/scripts` is `purge:temp`; it switches to
  `tsx .\scripts\purge-temp-dirs-main.ts`, matching the other tsx-run scripts.

`scripts/sync-dist-runtime.ts`:

- Delete `cleanCompiledOutputs` and `syncDistRuntime` (the wipe and the move).
- Keep and retarget the two remaining post-steps: write `dist/package.json`
  (`{"type":"module"}`) and `ensureCliShebang(dist/cli/main.js)`.
- `--clean` handling is removed; a missed caller fails loudly (unknown flag → throw).

`package.json` scripts:

- `build`: `tsc -b .\tsconfig.json && node --experimental-strip-types .\scripts\dashboard-stamp.ts && node --experimental-strip-types .\scripts\sync-dist-runtime.ts`
  — the stamp script itself runs `npm --prefix .\dashboard run build` on a stamp miss,
  so `dashboard/package.json` needs no new script.
- `purge:temp`: `tsx .\scripts\purge-temp-dirs-main.ts`.
- New `build:clean`: removes `dist/`, `.tscache/*.tsbuildinfo` (build ones),
  `packages/contracts/dist` + its tsbuildinfo, `dashboard/dist` — the escape hatch for
  corrupted incremental state.
- New `typecheck:scripts` no longer needed as a separate entry if `typecheck` already
  runs `tsc -p tsconfig.scripts.json --noEmit`; the existing `typecheck` chain keeps
  working because the config is now noEmit anyway.

### 2. Dashboard: content stamp

New `scripts/dashboard-stamp.ts` (~50 lines):

- Inputs hashed: `dashboard/src/**`, `dashboard/index.html`, `dashboard/package.json`,
  `dashboard/vite.config.ts`, `dashboard/tsconfig.json`, `packages/contracts/src/**`.
- Hash = SHA-256 over sorted relative paths + file contents.
- Compare against `dashboard/dist/.build-stamp`. Match → print "dashboard up to date"
  and exit 0 without building. Miss (or missing `dashboard/dist`) → run the Vite build,
  then write the stamp.
- The stamp lives inside `dashboard/dist` so any manual deletion of the output also
  invalidates the stamp.

### 3. refresh-global.ps1: desktop steps

Inserted before the pack/install sequence:

1. Toolchain check: if `<TOOLING_ROOT>/cargo/bin/cargo-tauri.exe` is missing, run
   `npm run desktop:install-toolchain`. `TOOLING_ROOT` resolution mirrors
   `scripts/desktop/toolchain-paths.mjs` (`SIFTKIT_TOOLING_ROOT` env override, else
   `..\.tooling\siftkit-gate-d` next to the checkout).
2. `npm run desktop:build` (`cargo tauri build`, full MSI/NSIS installers). Cargo skips
   unchanged crates natively.

The built shell is **not** added to the npm tarball; `files` in `package.json` is
unchanged. Existing pack / global-install / smoke-check flow is untouched.

### 4. build-test.ts

- Full path: drop the `--clean` invocation and the post-tsc sync call; replace
  `tsc -p tsconfig.json && tsc -p tsconfig.scripts.json` with `tsc -b tsconfig.json`
  followed by the (now marker/shebang-only) sync step. Contracts build via
  `npm --prefix packages/contracts run build` becomes redundant (`tsc -b` handles it)
  and is removed.
- Tests-only fast path (esbuild per-entry change detection) is already incremental —
  untouched.

### 5. Tests

- `tests/benchmark-spec-settings.test.ts`: update the six assertion sites pinning the
  old build wiring (`:642`, `:686`, `:719`, `:740`, `:767`, `:786`) — the
  `cleanCompiledOutputs`/`syncDistRuntime` unit tests are deleted with their subjects.
- `tests/sync-dist-runtime-shebang.test.ts`: unchanged unless `ensureCliShebang`'s
  signature moves.
- New regression coverage:
  - Second consecutive `tsc -b` run performs no emit (up-to-date check) — asserted via
    output mtimes or `--dry` output in a scoped fixture, or by asserting the build
    script wiring if a live double-build is too slow for the suite.
  - `dashboard-stamp` skips when inputs unchanged and rebuilds when a hashed input
    changes (unit-testable against a temp fixture tree).
  - `refresh-global.ps1` contains the toolchain check + desktop build steps (string
    assertions consistent with how the suite already pins script wiring).

## Explicitly out of scope

- Shipping the desktop binary in the npm tarball.
- Any change to `desktop/src-tauri` Rust code or the daemon spawn path.
- Assistant enablement/config (separate topic from this session).

## Validation

1. `npm run build` twice from clean: second run near-instant, `dist/` byte-identical.
2. `npm run typecheck` and `npm run lint` clean.
3. `npm test` (full suite) green.
4. `npm run refresh-global` end-to-end: toolchain detected/installed, desktop build
   succeeds, global `siftkit --help` + `repo-search --help` + quote round-trips pass.
5. `tests/package-artifact.test.ts` confirms tarball contents unchanged.

## Risks

- **Silent build breakage** is the class of risk: wrong rootDir or stale buildinfo can
  produce a broken `dist` without an error. Mitigations: `tsc -b` verifies outputs
  exist before skipping; `build:clean` escape hatch; validation step 1 diffs `dist`.
- Stale `packages/contracts/dist` previously couldn't happen (root compiled contracts
  source directly); now `tsc -b` owns that ordering, and the tests-only fast path in
  `build-test.ts` must keep typechecking against fresh contracts output — the fast
  path's `tsc -p tsconfig.test-build.json` gate still resolves contracts via the
  workspace symlink, so a stale `dist` there surfaces as type errors, not silence.
- First `cargo tauri build` downloads NSIS/WiX bundler tooling (one-time, minutes).
- `dashboard/tsconfig.json` keeps its own `paths` mapping to contracts **source**;
  that is Vite/bundler-resolution territory and is intentionally left alone.
- Configs that `extends` the root (`tsconfig.test.json`, `tsconfig.bench.json`,
  `tsconfig.analysis.json`, `tsconfig.scripts.json`, `tsconfig.test-build.json`) lose
  the inherited `paths` mapping and will resolve `@siftkit/contracts` through the
  workspace symlink to `packages/contracts/dist`. Their typechecks therefore require
  contracts to be built; a stale contracts `dist` surfaces as type errors (loud), and
  `references` are not inherited via `extends`, so none of them accidentally become
  build orchestrators.
