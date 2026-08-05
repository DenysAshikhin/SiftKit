# Explicit Assistant Transactions and Token Trimming Design

## Goal

Remove application-level transaction callbacks and consolidate duplicated projection token trimming without changing observable assistant behavior.

## Scope

This change covers two session-drift findings:

1. Replace `AssistantGraph.transaction(callback)` and direct assistant-service uses of `database.transaction(callback)()` with explicit, reusable transaction scopes.
2. Replace the duplicated token-limit loops in `ProfileCompiler` and `DossierCompiler` with one reusable class.

It does not change assertion conflict rules, ingestion outcomes, projection formatting, tier limits, or public CLI/HTTP behavior.

## Explicit Transaction Architecture

Add `AssistantTransactionManager`, owned by `AssistantGraph` and injected into every assistant service that starts a transaction. Calling `begin()` returns an `AssistantTransactionScope` with explicit `commit()` and `rollback()` methods. Application code performs its existing writes between those calls; it never passes a function into the transaction layer.

The manager uses `BEGIN` for the outermost scope and uniquely named SQLite `SAVEPOINT` statements for nested scopes. This preserves the current atomic behavior where `CandidatePromoter` starts an outer transaction and calls transactional assertion operations inside it. Nested commits release their savepoints. Nested rollbacks use `ROLLBACK TO SAVEPOINT` followed by `RELEASE SAVEPOINT`. The outer scope uses `COMMIT` or `ROLLBACK`.

Scopes are strictly last-in-first-out and single-use. Committing or rolling back a closed scope, or closing scopes out of order, fails loudly. A failed commit attempts rollback before rethrowing so the connection is not left in a transaction.

`AssistantGraph.transaction(callback)` is removed completely. The transaction manager is exposed as `AssistantGraph.transactions` for ingestion components. `AssertionService` and `NodeMergeService` receive the same manager through their constructors and use explicit scopes internally. There is no callback compatibility shim or dual transaction path.

Each transactional method follows this shape:

```ts
const transaction = this.transactions.begin();
try {
  const result = this.performWrites();
  transaction.commit();
  return result;
} catch (error) {
  transaction.rollback();
  throw error;
}
```

The existing store contract remains unchanged: stores assume their caller owns the transaction. Graph-version increments remain exactly where they are, preserving one increment per successful graph mutation.

## Shared Token Trimming

Add `TokenLimitEnforcer` under `src/assistant/projections`. It receives the existing `TokenCounter` through its constructor and exposes:

```ts
enforce(
  lines: readonly string[],
  tokenLimit: number,
): Promise<{ body: string; droppedLines: number }>;
```

It copies the input lines, counts the joined body, and removes the last line beginning with `- ` until the body fits or no removable line remains. This exactly preserves both current compilers' behavior.

`ProjectionCompiler` constructs one enforcer and shares it with `ProfileCompiler` and `DossierCompiler`. Their private duplicated `enforceLimit` methods are deleted. Compiler-specific omission accounting remains in each compiler because the semantics differ.

## Error Handling

- Transaction scopes reject double-close and out-of-order close operations.
- Rollback preserves the original application error. A rollback error is surfaced only when no earlier application error exists.
- Nested rollback affects only its savepoint; an uncaught error then causes the outer caller to roll back its scope.
- Token trimming propagates token-counter failures unchanged.

## Testing

Implementation follows TDD.

Transaction tests first demonstrate:

- outer commit persists writes;
- outer rollback discards writes;
- nested commit persists with the outer commit;
- nested rollback discards only nested writes when the caller handles the error;
- double-close and out-of-order close fail loudly;
- ingestion and assertion workflows retain their current atomic behavior;
- no application production code exposes or calls transaction callback APIs.

Projection tests first demonstrate that one enforcer preserves trimming order, input immutability, dropped-line counts, no-removable-line behavior, and propagation of token-counter errors. Existing projection compiler tests remain unchanged and must pass after both compilers share the class.

Run focused tests after each task, then the full test suite, typecheck, lint, and a banned-pattern scan.

## Non-Goals

- Changing SQLite transaction isolation or lock mode.
- Reworking store APIs or graph-version semantics.
- Combining profile and dossier rendering beyond their duplicated trimming algorithm.
- Changing projection token limits or line-removal priority.
