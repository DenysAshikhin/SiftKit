# Repo-Tool Drift Fixes Design

**Status:** Approved 2026-08-03

## Purpose

Resolve the three drift findings from the repo-tools globstar continuation:

1. Replace permissive positive-integer coercion across repo tools with strict runtime validation.
2. Prevent grep truncation from retaining a detached context group for an omitted match.
3. Cover root-relative ignored grep paths as exact entries, descendants, and case variants.

The work remains limited to these findings. It does not replace the complete repo-tool argument pipeline or introduce compatibility handling for values that were previously coerced.

## Strict positive-integer boundary

Define one reusable Zod schema in `src/repo-search/engine/repo-tools.ts`:

```ts
const PositiveIntegerSchema = z.number().int().positive().finite();
type PositiveInteger = z.infer<typeof PositiveIntegerSchema>;
```

All repo-tool numeric arguments that require positive integers use this schema:

- `read.offset`: defaults to `1` only when absent; a present invalid value fails with `offset must be a positive integer`.
- `read.limit`, `grep.limit`, `find.limit`, and `ls.limit`: use their existing defaults only when absent; a present invalid value fails with `limit must be a positive integer`.
- `grep.context`: remains omitted when absent; a present invalid value fails with `context must be a positive integer`.
- `run.timeout`: remains omitted when absent; a present invalid value fails with `timeout must be a positive integer (seconds)`.

Invalid means a string, fraction, zero, negative number, non-finite number, boolean, array, or object. No `Number()` conversion or `Math.trunc()` normalization remains for these arguments. This deliberately removes the old coercion behavior.

Small explicit resolver functions distinguish absent, valid, and invalid values. The schema is the single runtime and type source. `buildRepoToolRequestedCommand` uses the same strict parser when formatting raw planner arguments and never truncates them; each executor rejects any present invalid argument before use. Lower-level command builders accept normalized values and do not independently clamp, truncate, or default them.

`buildReadCommand` therefore accepts already-normalized values. Its previous `offset=0` fallback behavior is removed rather than preserved through a shim. Every production caller must establish the positive-integer invariant before calling it.

## Context-aware grep truncation

Ripgrep context output contains match lines (`path:line:text`), context lines (`path-line-text`), and `--` separators between non-overlapping groups.

`truncateGrepOutput` continues to count only match lines. When it encounters match `limit + 1`, it examines the lines since the last retained match:

- If that interval contains a `--` separator, truncation starts at that separator. The omitted match's entire detached group, including its leading context, is removed.
- If there is no separator, truncation starts at the omitted match. Intervening context belongs to the same overlapping group and remains valid trailing context for the retained match.

The overflow message remains unchanged and uses the total match count. A real ripgrep integration test uses widely separated matches so the RED failure exposes the orphan separator and context rather than merely checking the number of match lines.

## Ignored-path grep coverage

Production ignore-glob construction remains unchanged. Add real grep coverage for `ignorePolicy.paths` using baseline paths:

- An exact ignored entry such as `tmp-find` is excluded when it is a plain file.
- Descendants beneath an ignored path such as `eval/results/leak.ts` are excluded.
- Case variants such as `Eval/Results/leak.ts` are excluded through `--iglob`.
- A non-ignored file containing the same search term remains in the output, proving the search succeeded and exclusions—not an empty search—caused the omissions.

No mocks or source-text assertions are used.

## Testing and delivery

Each finding is an independently reviewable TDD task:

1. Add failing E2E-style repo-tool tests for strict positive integers, then replace all coercion paths with the shared schema.
2. Add a failing separated-context grep test, then make truncation group-aware.
3. Add ignored-path grep cases. Because this closes a coverage gap around behavior that already exists, prove the tests with a mutation check: temporarily remove the exact-path and descendant path exclusions, observe the focused test fail for the expected leak, restore production code, and observe it pass. Production code changes only if the restored implementation still fails.

Every task runs the focused test first to prove RED, then the complete `tests/repo-tools.test.ts` suite and `npm run typecheck` after GREEN. The final gate runs `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, and the existing live `**/package.json` smoke. Temporary artifacts use the managed test-directory registry and are removed before completion.

## Constraints

- TypeScript only, inferred from runtime schemas at input boundaries.
- No type-assertion casts, `any`, non-null assertions, or namespace imports.
- No dynamically-passed functions.
- No legacy compatibility, coercion shims, or dual paths.
- Reuse the existing repo-tool execution and test infrastructure.
- Keep helpers explicit, local, and minimal; do not introduce a class or new module for one schema.
- Preserve existing error strings unless this design specifies a field-specific replacement.
