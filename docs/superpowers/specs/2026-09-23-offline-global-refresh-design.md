# Offline Global Refresh Design

## Problem

`npm run refresh-global` failed during `npm i -g <tarball>` because DNS for `registry.npmjs.org` was down
(`ENOTFOUND`, then npm's "Exit handler never called!"). The global install re-resolves every runtime
dependency from the registry even though the repo already has them installed and built.

## Goal

Refresh (reconcile install, desktop build, pack, global install) must not require internet access.
Any missed network access fails loudly instead of hanging or silently using a stale cache.

Out of scope: the one-time portable Rust toolchain download when the toolchain is missing (kept as is).

## Design

1. `package.json`: `"bundleDependencies": true`. npm bundles every production dependency from the
   repo's `node_modules` (prebuilt native binaries included) into the tarball, so the global install
   resolves nothing from the registry. Replaces the single-entry `["@siftkit/contracts"]` list.
2. `scripts/refresh-global.ps1`:
   - reconcile install: `npm install --offline --loglevel error`
   - global install: add `--offline` to `npm i -g <tarball> --force --no-audit`
   - desktop build: run with `CARGO_NET_OFFLINE=true`, restored after the step.

## Evidence

- Scratch package with zod, better-sqlite3, @napi-rs/image, jsdom bundled: `npm i -g <tgz> --offline`
  with an empty cache and a temp prefix succeeded; native modules loaded and executed.
- `npm install --offline` in the repo: up to date, exit 0.
- `CARGO_NET_OFFLINE=true npm run desktop:build`: exit 0.

## Testing

- `tests/package-artifact.test.ts`: `bundleDependencies === true`; pack manifest contains
  `node_modules/zod/package.json` in addition to the contracts entrypoint.
- `tests/refresh-global-script.test.ts`: reconcile and global install calls include `--offline`;
  the desktop build step sets `CARGO_NET_OFFLINE`.

## Trade-off

Larger local tarball (jsdom tree). It is gitignored and never published.
