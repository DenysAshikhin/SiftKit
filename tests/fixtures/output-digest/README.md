# Output digest fixtures

Real console output, captured on Windows 11 from small scratch projects on 2026-11-02, one directory per parser in `src/output-digest/`. `tests/output-digest-parsers.test.ts` checks each file's exact digest. Paths inside the files are the capture machine's paths; keep them, since parsers report locations as the tool printed them.

| Directory | Tool and version | Cases |
|---|---|---|
| `node-test` | Node.js v26.7.0 `node --test`, spec reporter | `pass`; `fail` (assertion diff, thrown error, subtest, file that fails to load); `bad-path` (a directory passed as a test file); `noisy-e2e-fail` (a SiftKit orchestrator e2e run with server logs between results) |
| `vitest` | vitest 4.1.11 | `pass`, `fail` |
| `jest` | jest 30.5.2 (ANSI colour codes kept) | `pass`, `fail` |
| `pytest` | pytest 9.1.1 on Python 3.14.7 | `pass`, `fail`, `collection-error` |
| `dotnet-test` | .NET SDK 10.0.301 `dotnet test`, xUnit adapter 3.1.4 | `pass`, `fail` (classic logger), `fail-terminal-logger` (`--tl:on`) |
| `msbuild` | .NET SDK 10.0.301 `dotnet build` | `pass`, `fail` (classic logger), `fail-terminal-logger` (ANSI and OSC codes kept) |
| `go-test` | go 1.27.3 `go test ./...` | `pass`, `pass-verbose`, `fail`, `fail-verbose`, `build-error` |
| `cargo-test` | cargo and rustc 1.99.0 `cargo test` | `pass`, `fail`, `compile-error` |
| `tsc` | TypeScript 5.9.3 | `fail` (`--pretty false`), `fail-pretty` |
| `mypy` | mypy 2.4.1 | `pass`, `fail` |
| `pyright` | pyright 1.1.414 | `pass`, `fail` |
| `eslint` | ESLint 9.39.4, stylish formatter | `fail`, `warn-only` (a passing eslint or tsc run prints nothing, so there is no pass file) |
