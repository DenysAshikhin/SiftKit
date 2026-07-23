# SiftKit Self-Call Drift Remediation Design

## Goal

Remove the command-classification bandaid, replace hardcoded E2E polling with a reusable condition-based harness helper, and mutation-verify the existing regression tests for the two behavior slices that lacked observed RED evidence.

## Scope

- Refactor CLI command classification into one typed source of truth.
- Preserve all current public, hidden, server-dependent, and model-lock behavior.
- Replace inline owner-run polling in `nested-agent-server-reject.test.ts`.
- Mutation-verify the existing command-env and server self-lineage regression tests.
- Run the complete test suite after focused validation.

## Non-Goals

- Rewriting Git history to simulate historical TDD order.
- Adding permanent mutation-testing infrastructure.
- Changing nested summary trimming, server lock architecture, or header semantics.
- Adding compatibility exports for removed command sets and parsing helpers.

## Command Catalog

Create `src/cli/command-catalog.ts` with a reusable `CliCommandCatalog` class and a single exported catalog instance.

Each registered command has one definition:

- canonical name;
- whether it is publicly exposed;
- whether it requires status-server preflight;
- whether it acquires the model-request lock.

The catalog owns invocation resolution and returns a typed value containing the command definition and argument list.

Resolution order is:

1. An explicitly registered command uses its registered definition and removes the command token from its arguments.
2. `--prompt` and `-prompt` resolve to `repo-search` while preserving the full argument list.
3. Every other token sequence resolves to implicit `summary` while preserving the full argument list.

The existing `KNOWN_COMMANDS`, `BLOCKED_PUBLIC_COMMANDS`, `SERVER_DEPENDENT_COMMANDS`, and `MODEL_LOCK_COMMANDS` exports are removed. Callers migrate to the catalog in the same change; no compatibility layer remains.

`SERVER_DEPENDENT_INTERNAL_OPS` remains separate because it classifies internal operation names rather than public CLI invocations.

## Dispatch Flow

`runCli` resolves the invocation once and uses the returned definition throughout:

1. Help handling remains first.
2. A nested non-summary model-lock command returns the deadlock error.
3. A non-exposed command returns the existing "not exposed" error.
4. Command-specific token validation runs against the resolved arguments.
5. Status-server preflight uses `serverDependent`, except nested summary passthrough.
6. Dispatch switches on the canonical command name.

This ordering intentionally lets nested hidden `eval` report the deadlock error while ordinary `eval` and all non-model hidden commands remain unavailable.

## Deterministic Owner Wait

Add `waitForActiveModelRequestOwner(baseUrl: string): Promise<string>` to `tests/helpers/streamed-op-harness.ts`.

The helper:

- polls `/status` for `modelRequests.activeRequest.ownerRunId`;
- uses named deadline and interval constants;
- uses `node:timers/promises` rather than embedding a Promise callback in the E2E test;
- throws a precise timeout error if no owner appears.

`nested-agent-server-reject.test.ts` uses the helper and replaces inline values with named request and lock-hold constants. `simulateWorkMs` remains only as the existing harness mechanism that keeps the real repo-agent request active; its value is named and chosen to exceed the owner-wait deadline.

## TDD and Mutation Validation

All permanent changes follow RED-GREEN-REFACTOR:

1. Add catalog contract tests that fail because the catalog does not exist.
2. Implement the catalog and migrate dispatch until focused CLI tests pass.
3. Add a harness-helper test that fails because the helper does not exist.
4. Implement the owner-wait helper and migrate the E2E test.

The earlier env-marker and self-lineage tests already provide permanent regression coverage. To verify that they detect the guarded behavior:

1. Add one temporary line that neutralizes env propagation.
2. Run the focused tests and record the expected failure.
3. Remove the temporary line and confirm GREEN.
4. Add one temporary line that neutralizes self-lineage matching.
5. Run the focused E2E test and record the expected failure.
6. Remove the temporary line and confirm GREEN.

Temporary mutation lines are never committed. This validates test sensitivity without claiming to change historical TDD order.

## Testing

Focused validation covers:

- explicit public command resolution;
- hidden command resolution;
- `--prompt` shorthand;
- implicit summary fallback;
- nested `eval` with arguments;
- nested summary positional input;
- nested non-model hidden commands;
- condition-based owner discovery;
- matching lineage rejection;
- mismatched lineage queueing;
- env propagation through native and fallback command execution.

Final validation runs `npm test` and requires zero failures.
