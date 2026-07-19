# Self-Contained Global Refresh Design

## Problem

`npm run refresh-global` builds and packs SiftKit, but the generated tarball declares the private workspace package `@siftkit/contracts` as an ordinary `"*"` dependency without including it. A global install therefore requests the package from npmjs.org and fails with `E404`.

The refresh script then invokes an automatic shell-integration fallback. That fallback is a separate installation path with different behavior and currently fails while copying the repository's `node_modules/@siftkit/contracts` workspace junction. The fallback also masks the original packaging defect.

## Design

Global refresh will have one authoritative installation path:

1. Build all runtime artifacts, including `@siftkit/contracts`.
2. Pack the root SiftKit package with `@siftkit/contracts` declared in `bundleDependencies`.
3. Stop the previously installed global status server, if present.
4. Install the generated tarball globally with npm.
5. Resolve the npm-generated global command and run the existing public CLI smoke checks.

The packed tarball must contain the compiled contracts package under `package/node_modules/@siftkit/contracts`. npm will then satisfy the root `@siftkit/contracts` dependency from the bundled package without querying the registry.

`scripts/refresh-global.ps1` will remove its private `Install-SiftKitViaShellIntegration` helper and the catch block that invokes it. Packing, installation, command resolution, or smoke-check failures will terminate refresh with the original error.

The explicit public `Install-SiftKitShellIntegration` command remains available and is outside this change. Only its use as an automatic global-refresh fallback is removed.

## Testing

Automated regressions will verify:

- package metadata declares `@siftkit/contracts` as a bundled dependency;
- `npm pack` includes the compiled contracts entrypoint in the tarball;
- `refresh-global.ps1` contains only the npm tarball installation path and no fallback invocation.

Validation will install the packed tarball, run `siftkit --help` and `siftkit repo-search --help`, run the full test and typecheck/lint suites, and confirm no SiftKit-managed processes remain afterward.

## Non-Goals

- Publishing `@siftkit/contracts` separately.
- Replacing npm with a custom installer.
- Removing or redesigning the explicit shell-integration installation command.
- Changing backend, preset, or dashboard configuration behavior.
