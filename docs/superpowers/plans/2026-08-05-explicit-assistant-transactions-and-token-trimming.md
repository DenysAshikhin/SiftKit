# Explicit Assistant Transactions and Token Trimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace application-level transaction callbacks with explicit nested transaction scopes and make projection token trimming a single reusable class.

**Architecture:** `AssistantTransactionManager` owns a strict LIFO stack of explicit SQLite transactions/savepoints and returns single-use scopes with `commit()` and `rollback()`. `TokenLimitEnforcer` owns the existing drop-last-cited-line algorithm and is shared by both projection compilers.

**Tech Stack:** TypeScript, better-sqlite3, Node test runner, Node strict assertions.

## Global Constraints

- Follow TDD: add the focused test and observe the expected RED result before production edits.
- Do not add callback-based transaction APIs, compatibility shims, casts, `any`, non-null assertions, namespace imports, or dynamically dispatched handler maps.
- Preserve current transaction atomicity, nested-savepoint behavior, graph-version increments, projection bytes, and omission accounting.
- Keep all code succinct and class-based; reuse existing stores and token-counter interfaces.
- Do not commit inside `repo-agent`; the parent reviews, validates, and commits each task.

---

### Task 1: Explicit nested assistant transaction scopes

**Files:**
- Create: `src/assistant/transactions/assistant-transaction-manager.ts`
- Create: `tests/assistant-transaction-manager.test.ts`
- Modify: `src/assistant/assistant-graph.ts`
- Modify: `src/assistant/graph/assertion-service.ts`
- Modify: `src/assistant/graph/merge-service.ts`
- Modify: `src/assistant/ingestion/candidate-promoter.ts`
- Modify: `src/assistant/ingestion/consolidator.ts`
- Modify: `src/assistant/ingestion/conversation-extractor.ts`
- Modify: `src/assistant/ingestion/pipeline.ts`

**Interfaces:**
- Consumes: `RuntimeDatabase.exec(sql: string): void` and existing assistant stores/services.
- Produces: `AssistantTransactionManager.begin(): AssistantTransactionScope`; `AssistantTransactionScope.commit(): void`; `AssistantTransactionScope.rollback(): void`.
- Produces: `AssistantGraph.transactions: AssistantTransactionManager`; removes `AssistantGraph.transaction<T>(body: () => T): T`.

- [ ] **Step 1: Write the failing transaction-manager tests**

Create `tests/assistant-transaction-manager.test.ts`. Use an isolated assistant fixture and real SQLite writes. Cover all of these behaviors:

```ts
test('an outer commit persists writes', () => {
  // begin, insert runtime_metadata row, commit, assert row exists
});

test('an outer rollback discards writes', () => {
  // begin, insert row, rollback, assert row is absent
});

test('nested commits persist with the outer commit', () => {
  // outer begin, insert A, inner begin, insert B, inner commit, outer commit
});

test('a handled nested rollback preserves outer writes', () => {
  // outer begin, insert A, inner begin, insert B, inner rollback, outer commit
  // assert A exists and B does not
});

test('scopes close once and in last-in-first-out order', () => {
  // assert outer.commit() rejects while inner is open
  // close inner then outer; assert a second close rejects
});
```

Assert durable database state, not implementation counters or mocks. Use fixed literal metadata keys unique to each test.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node --experimental-strip-types --test tests/assistant-transaction-manager.test.ts
```

Expected: FAIL because `src/assistant/transactions/assistant-transaction-manager.ts` does not exist.

- [ ] **Step 3: Implement explicit nested scopes**

Create `AssistantTransactionManager` and `AssistantTransactionScope` in the new production file.

Required behavior:

```ts
export class AssistantTransactionManager {
  constructor(database: RuntimeDatabase);
  begin(): AssistantTransactionScope;
}

export class AssistantTransactionScope {
  commit(): void;
  rollback(): void;
}
```

Implementation rules:

- The first `begin()` executes `BEGIN`.
- Nested `begin()` executes `SAVEPOINT assistant_tx_<monotonic integer>`.
- Outer `commit()` executes `COMMIT`; nested `commit()` executes `RELEASE SAVEPOINT <name>`.
- Outer `rollback()` executes `ROLLBACK`; nested `rollback()` executes `ROLLBACK TO SAVEPOINT <name>` and then `RELEASE SAVEPOINT <name>`.
- Keep private scope records in a stack. Only the current top record may close.
- Remove a record only after its close SQL succeeds. Mark successful scopes closed; reject double-close and out-of-order close with exact, stable errors.
- Savepoint names derive only from the manager's private integer; never interpolate caller input.
- Do not accept, store, or invoke function values.

- [ ] **Step 4: Run the transaction-manager tests and verify GREEN**

Run the focused test command from Step 2.

Expected: all transaction-manager tests PASS.

- [ ] **Step 5: Replace every assistant transaction callback**

Construct one manager in `AssistantGraph`, expose it as readonly `transactions`, and inject it into `AssertionService` and `NodeMergeService` instead of the raw database transaction dependency.

Replace every application transaction wrapper with explicit scope ownership:

```ts
const transaction = this.transactions.begin();
try {
  const result = this.performExistingWrites();
  transaction.commit();
  return result;
} catch (error) {
  transaction.rollback();
  throw error;
}
```

Use that shape in all existing transaction-owning methods. Preserve the existing method bodies and return values. For the ingestion classes, replace `graph.transaction(() => { ... })` with explicit `graph.transactions.begin()` scopes. Preserve nested behavior in `CandidatePromoter`: its outer scope must contain the candidate update, audit write, and nested assertion/correction scope.

Delete `AssistantGraph.database` if it becomes unused. Delete `AssistantGraph.transaction` completely. Do not leave a deprecated alias or compatibility wrapper.

- [ ] **Step 6: Verify focused behavior and absence of callback paths**

Run:

```powershell
node --experimental-strip-types --test tests/assistant-transaction-manager.test.ts tests/assistant-assertion-service.test.ts tests/assistant-merge.test.ts tests/assistant-candidate-promoter.test.ts tests/assistant-consolidator.test.ts tests/assistant-conversation-extractor.test.ts tests/assistant-ingestion-pipeline.test.ts tests/assistant-gate-a-e2e.test.ts
```

Expected: all focused tests PASS.

Search `src/assistant` for `\.transaction\(` and `transaction<T>(body`; expected result: no application callback transaction API or call remains. Only explicit manager/scope transaction SQL is allowed.

Run `npm run typecheck`; expected: PASS.

Parent review gate: inspect only Task 1's diff, scan banned patterns and callback values, run the focused tests/typecheck independently, then commit the reviewed task.

---

### Task 2: Shared projection token-limit enforcer

**Files:**
- Create: `src/assistant/projections/token-limit-enforcer.ts`
- Create: `tests/assistant-token-limit-enforcer.test.ts`
- Modify: `src/assistant/projections/profile-compiler.ts`
- Modify: `src/assistant/projections/dossier-compiler.ts`
- Modify: `src/assistant/projections/projection-compiler.ts`

**Interfaces:**
- Consumes: `TokenCounter.count(text: string): Promise<TokenCount>`.
- Produces: `TokenLimitEnforcer.enforce(lines: readonly string[], tokenLimit: number): Promise<{ body: string; droppedLines: number }>`.
- `ProfileCompiler` and `DossierCompiler` consume the same enforcer instance constructed by `ProjectionCompiler`; direct construction remains possible by constructing an enforcer explicitly at the existing test/caller boundary.

- [ ] **Step 1: Write the failing enforcer tests**

Create `tests/assistant-token-limit-enforcer.test.ts` with a small explicit `TokenCounter` class whose token count equals the text length. Cover:

```ts
test('returns an unchanged body when it fits', async () => {});
test('drops cited lines from the end until the body fits', async () => {});
test('does not mutate the input lines', async () => {});
test('stops when no removable cited line remains', async () => {});
test('propagates token-counter failures', async () => {});
```

Assert the exact joined body and exact `droppedLines` count. A removable line is exactly a line beginning with `- `, matching current compiler behavior.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node --experimental-strip-types --test tests/assistant-token-limit-enforcer.test.ts
```

Expected: FAIL because `src/assistant/projections/token-limit-enforcer.ts` does not exist.

- [ ] **Step 3: Implement the minimal reusable class**

Create:

```ts
export class TokenLimitEnforcer {
  constructor(private readonly tokens: TokenCounter) {}

  async enforce(
    lines: readonly string[],
    tokenLimit: number,
  ): Promise<{ body: string; droppedLines: number }> {
    // Copy lines, count joined body, remove the last `- ` line until within limit.
  }
}
```

Do not introduce configuration, strategies, callbacks, or additional result types.

- [ ] **Step 4: Run the enforcer tests and verify GREEN**

Run the focused test command from Step 2.

Expected: all enforcer tests PASS.

- [ ] **Step 5: Replace both duplicated compiler loops**

- Change `ProfileCompiler` and `DossierCompiler` constructors to receive `TokenCounter` and `TokenLimitEnforcer` explicitly, or receive only the shared enforcer plus the token counter if both are needed for final counts. Keep dependencies typed and constructor wiring explicit.
- Delete both private `enforceLimit` methods.
- Call `enforcer.enforce(lines, TIER_TOKEN_LIMIT[...])` in each compiler.
- Construct one `TokenLimitEnforcer` in `ProjectionCompiler` and pass the same instance to both compilers.
- Update direct compiler construction in tests to construct the dependency explicitly. Do not add optional/default constructor shims.
- Preserve profile `droppedLines` accounting and dossier surviving-assertion accounting exactly.

- [ ] **Step 6: Verify projection behavior and full repository health**

Run:

```powershell
node --experimental-strip-types --test tests/assistant-token-limit-enforcer.test.ts tests/assistant-projection-compiler.test.ts
npm run typecheck
npm test
```

Expected: all focused tests, typecheck/lint stages, and the full suite PASS with no new skips.

Search the two compiler files for `private async enforceLimit`; expected: no matches. Review the diff for casts, `any`, non-null assertions, namespace imports, callback values, compatibility shims, duplicated trimming loops, and unrelated changes.

Parent review gate: inspect only Task 2's diff, independently rerun focused tests/typecheck/full suite, clean scratch artifacts, then commit the reviewed task.

