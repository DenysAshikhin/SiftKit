# CLI Resolved Arguments Contract Design

**Date:** 2026-07-23

## Goal

Replace the hardcoded source-file architecture test with a shared TypeScript contract and existing behavior-level CLI coverage.

## Architecture

`src/cli/args.ts` owns a `ResolvedCliArgs` type containing `args: string[]`. Every runner that receives already-resolved command arguments includes that contract in its options type.

`runCli` remains the production resolution boundary. `commandReadsStdin` remains the separate pre-dispatch query required before stdin is read. Runners continue to avoid runtime or type-only dependencies on `command-catalog.ts`.

## Test Strategy

- Add a compile-time contract fixture that imports and satisfies `ResolvedCliArgs`; verify TypeScript fails before the type exists.
- Keep catalog resolution and exposed-command behavior tests.
- Delete filesystem imports, the `RESOLVED_ARGS_RUNNERS` filename list, and regex assertions over source text.
- Use existing CLI integration tests to verify arguments still reach summary, repo-search, repo-agent, run, preset, internal, and other runner paths correctly.
- Run full typecheck and test suites after the refactor.

## Constraints

- Do not change runtime CLI behavior or public syntax.
- Do not reintroduce raw `argv` runner options.
- Do not add a source parser, lint dependency, compatibility alias, cast, `any`, non-null assertion, namespace import, or dynamically-passed function.
- Do not modify duplicate-command handling or exhaustive-dispatch validation; those are outside this request.

## Files

- Modify `src/cli/args.ts` to define `ResolvedCliArgs`.
- Modify runner files to use the shared contract.
- Modify `tests/cli-command-catalog.test.ts` to replace the source scan with the compile-time contract fixture.
