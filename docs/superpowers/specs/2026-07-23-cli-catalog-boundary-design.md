# Typed CLI Catalog Boundary Design

**Date:** 2026-07-23

## Goal

Make `CliCommandCatalog` the typed, canonical command-resolution boundary, remove repeated command resolution from CLI runners, and remove the nested-agent test's global `process.stderr.write` replacement.

## Architecture

`CLI_COMMAND_DEFINITIONS` is the source of both runtime command metadata and the inferred `CliCommandName` union. `runCli` resolves raw `argv` once and passes only the resolved argument tokens to command runners. Runners do not import or call the catalog.

The catalog exposes its public command names so dispatch errors cannot maintain a second hardcoded command list. `help` remains an explicit non-command entry in the displayed list.

## Types

- Define command metadata as a literal tuple constrained with `as const satisfies`.
- Derive `CliCommandName` from the tuple rather than declaring command names as `string`.
- Type `CliCommandDefinition.name`, the catalog map, and resolved invocations with `CliCommandName`.
- Make dispatch exhaustive: adding a catalog command without a dispatch case must fail TypeScript compilation.
- Do not add casts other than the allowed `as const`; do not add `any`, non-null assertions, namespace imports, or compatibility overloads.

## CLI Data Flow

1. `runCli` receives raw `argv`.
2. `CLI_COMMAND_CATALOG.resolve(argv)` produces one `CliCommandInvocation`.
3. Dispatch consumes `invocation.command` metadata and `invocation.args`.
4. Each selected runner receives `args`, not raw `argv`, and parses those tokens directly.
5. The catalog supplies exposed command names for the not-exposed error.

`commandReadsStdin` remains a separate pre-dispatch query because the process entrypoint must decide whether to read stdin before calling `runCli`. Within `commandReadsStdin`, resolution still occurs exactly once.

## Runner Interface Changes

Internal runner option types replace `argv: string[]` with `args: string[]` wherever the runner currently strips the command through `CLI_COMMAND_CATALOG.resolve`. There are no legacy `argv` aliases or overloads. Direct tests and internal callers migrate to the new contract.

Runners that already consume a different shape remain unchanged.

## Test Cleanup

`nested-agent-guard.test.ts` removes `runGuardedCliWithProcessStderr` and its reassignment of `process.stderr.write`. The nested `eval` test uses `runGuardedCli` directly. Its dead status-server URLs and expected fail-fast result already prove the command did not cross the HTTP boundary.

## TDD and Verification

1. Add a failing catalog test for the complete exposed-command list.
2. Add a compile-time contract test by changing runner tests to call the desired `args` interfaces, then confirm TypeScript fails against the old signatures.
3. Implement the literal-derived command types and exposed-name API.
4. Change dispatch and runners to the args-only boundary.
5. Remove the global stderr replacement after the focused nested-agent tests remain green without it.
6. Run catalog, command-surface, stdin, CLI runner, nested-agent, typecheck, and full test suites.
7. Scan the changed TypeScript for prohibited casts, `any`, non-null assertions, namespace imports, legacy helpers, and repeated catalog resolution.

## Non-Goals

- Do not change CLI command behavior or public syntax.
- Do not change nested-summary passthrough semantics.
- Do not move stdin reading into dispatch.
- Do not add compatibility shims for old runner signatures.
- Do not add a generalized dependency-injection layer for stderr or logging.
