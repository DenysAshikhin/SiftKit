# Chat Session Model-Preset Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-name inference with required model-preset identity, remove the hardcoded context fallback and client model overrides, and independently mutation-verify each E2E behavior.

**Architecture:** Chat sessions persist `modelPresetId` plus model/context snapshots. Active preset identity resolves current model/context; inactive or deleted identities use snapshots. A forward-only SQLite v33 migration deterministically backfills required IDs, while HTTP clients lose all authority to select chat-backed models.

**Tech Stack:** TypeScript, Zod-derived contracts, Node.js HTTP server, SQLite/better-sqlite3, React dashboard, `node:test`, c8.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-chat-session-model-preset-identity-design.md`.
- Follow strict red-green-refactor TDD; each changed behavior must be observed failing before implementation.
- Prefer complete E2E tests; use unit tests for contract and pure resolver branches only.
- Do not retain a model-name compatibility resolver, default model-preset ID, or client model override.
- No type assertions, `any`, non-null assertions, namespace imports, unknown laundering, or dynamically passed functions.
- Keep production functions explicit and reuse canonical config getters.
- Use one temporary directory for mutation logs and remove it before completion.
- Do not use worktrees.

---

### Task 1: Require Model-Preset Identity in Contracts and Persistence

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `tests/contracts-chat.test.ts`
- Modify: `tests/chat-sessions-db.test.ts`

**Interfaces:**
- Produces contract field `ChatSession.modelPresetId: string`.
- Produces internal field `ChatSession.modelPresetId: string` and SQLite row field `model_preset_id: string`.

- [ ] **Step 1: Add failing contract and persistence tests**

Add a contract test proving missing/empty identity is rejected:

```ts
const validSession = {
  id: 'session', title: 'Session', modelPresetId: 'exl3-main', model: 'model-a',
  contextWindowTokens: 150_000, condensedSummary: '', createdAtUtc: now,
  updatedAtUtc: now, messages: [],
};
assert.equal(ChatSessionSchema.safeParse(validSession).success, true);
assert.equal(ChatSessionSchema.safeParse({ ...validSession, modelPresetId: '' }).success, false);
```

Update the database round-trip fixture to set `modelPresetId: 'default'` and assert the read session and raw `model_preset_id` column equal `'default'`.

- [ ] **Step 2: Verify RED**

Run: `npm run test -- contracts-chat chat-sessions-db`

Expected: FAIL because the contract and SQLite mapping do not contain `modelPresetId`.

- [ ] **Step 3: Implement the required field**

Add to the contract:

```ts
modelPresetId: z.string().trim().min(1),
```

Add required `modelPresetId: string` to the internal `ChatSession`, `model_preset_id: z.string().min(1)` to `SessionRowSchema`, include the column in SELECT/INSERT/UPDATE, and bind `session.modelPresetId.trim()` after rejecting empty IDs:

```ts
function requireModelPresetId(session: ChatSession): string {
  const modelPresetId = session.modelPresetId.trim();
  if (!modelPresetId) throw new Error(`Chat session ${session.id} is missing modelPresetId.`);
  return modelPresetId;
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run test -- contracts-chat chat-sessions-db`

Expected: PASS.

Commit:

```powershell
git add -- packages/contracts/src/chat.ts src/state/chat-sessions.ts tests/contracts-chat.test.ts tests/chat-sessions-db.test.ts
git commit -m "feat: require chat model preset identity"
```

---

### Task 2: Add Forward-Only SQLite v33 Migration

**Files:**
- Modify: `src/state/runtime-db.ts`
- Create: `tests/runtime-db-schema-v33.test.ts`

**Interfaces:**
- Consumes `app_config.server_llama_presets_json`, `app_config.server_llama_active_preset_id`, and existing `chat_sessions.model`.
- Produces schema version `33` and `chat_sessions.model_preset_id TEXT NOT NULL`.

- [ ] **Step 1: Add failing migration tests**

Build v32 databases with the existing schema/config rows and assert:

```ts
test('v33 migration resolves unique and model-less chat session preset identities', () => {
  // session model-a -> preset-a; null model -> active preset-b
  const database = openMigratedDatabase(path);
  assert.deepEqual(readIdentities(database), [
    { id: 'model-session', modelPresetId: 'preset-a' },
    { id: 'model-less-session', modelPresetId: 'preset-b' },
  ]);
  assert.equal(readSchemaVersion(database), 33);
  assert.equal(readColumn(database, 'chat_sessions', 'model_preset_id')?.notnull, 1);
});
```

Add separate tests expecting migration errors containing session ID/model for zero matches and multiple matches.

- [ ] **Step 2: Verify RED**

Run: `npm run test -- runtime-db-schema-v33`

Expected: FAIL because schema version remains 32 and the column is absent.

- [ ] **Step 3: Implement deterministic migration**

Set `CURRENT_SCHEMA_VERSION = 33`. Add Zod schemas for the config row, preset identity subset, and session migration rows. Implement explicit helpers:

```ts
function resolveMigratedModelPresetId(
  session: { id: string; model: string | null },
  presets: Array<{ id: string; Model: string | null }>,
  activePresetId: string,
): string {
  if (!session.model?.trim()) return activePresetId;
  const matches = presets.filter((preset) => preset.Model?.trim() === session.model?.trim());
  if (matches.length !== 1) {
    throw new Error(`Cannot migrate chat session ${session.id} model ${session.model}: expected exactly one model preset, found ${matches.length}.`);
  }
  return matches[0].id;
}
```

Implement `migrateChatSessionsToModelPresetIdentity(database)` that parses preset JSON, creates `chat_sessions_v33` with the full final schema, copies each row with the resolved ID, disables foreign keys only for the drop/rename swap, restores them, and runs `PRAGMA foreign_key_check`. Call it under `currentVersion < 33`, then set version 33.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run test -- runtime-db-schema-v33 chat-sessions-db`

Expected: PASS for unique/model-less migrations and loud ambiguous/unmatched failures.

Commit:

```powershell
git add -- src/state/runtime-db.ts tests/runtime-db-schema-v33.test.ts
git commit -m "feat: migrate chat model preset identity"
```

---

### Task 3: Resolve Session Inference by Preset Identity and Require Config

**Files:**
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `tests/status-server-chat.test.ts`

**Interfaces:**
- Produces `resolveChatSessionModel(config: SiftConfig, session: ChatSession): string`.
- Changes `resolveChatSessionContextWindow`, `ContextUsageBuilder`, and `buildContextUsage` to require `SiftConfig`.

- [ ] **Step 1: Replace model-name tests with failing identity tests**

Add focused tests:

```ts
test('active model preset identity uses current model and context', () => {
  const session = mockChatSession({ modelPresetId: 'default', model: 'old-model', contextWindowTokens: 30_000 });
  assert.equal(resolveChatSessionModel(config, session), 'current-model');
  assert.equal(resolveChatSessionContextWindow(config, session), 150_000);
});

test('inactive model preset identity preserves model and context snapshots', () => {
  const session = mockChatSession({ modelPresetId: 'deleted-preset', model: 'old-model', contextWindowTokens: 30_000 });
  assert.equal(resolveChatSessionModel(config, session), 'old-model');
  assert.equal(resolveChatSessionContextWindow(config, session), 30_000);
});

test('inactive identity without valid snapshots fails loudly', () => {
  assert.throws(() => resolveChatSessionModel(config, missingModelSession), /missing model snapshot/);
  assert.throws(() => resolveChatSessionContextWindow(config, invalidContextSession), /missing context snapshot/);
});
```

Update every `buildContextUsage(null, session)` test to pass `createConfig()` and remove no-config resolver tests.

- [ ] **Step 2: Verify RED**

Run: `npm run test -- status-server-chat`

Expected: FAIL because ownership still compares model names and nullable config still compiles.

- [ ] **Step 3: Implement identity resolution**

Use explicit identity comparison:

```ts
function sessionUsesActiveModelPreset(config: SiftConfig, session: ChatSession): boolean {
  return session.modelPresetId === getActiveModelPreset(config).id;
}

export function resolveChatSessionModel(config: SiftConfig, session: ChatSession): string {
  if (sessionUsesActiveModelPreset(config, session)) return getConfiguredModel(config);
  if (session.model?.trim()) return session.model.trim();
  throw new Error(`Chat session ${session.id} is missing its model snapshot.`);
}
```

Apply the same identity rule to context and throw for invalid inactive snapshots. Require `SiftConfig` throughout context usage. Update wire serialization to emit `resolveChatSessionModel(config, session)`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run test -- status-server-chat dashboard-status-server`

Expected: PASS.

Commit:

```powershell
git add -- src/status-server/chat.ts src/status-server/routes/chat.ts tests/status-server-chat.test.ts
git commit -m "refactor: resolve chat inference by preset identity"
```

---

### Task 4: Remove Client Model Authority

**Files:**
- Modify: `src/status-server/chat-route-request-normalizers.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/hooks/useChatController.ts`
- Modify: related request-normalizer, status-server, API, hook, and dashboard tests located by compiler/test failures.

**Interfaces:**
- `ChatSessionCreateRequest` contains only `presetId` and optional `title`.
- Chat-backed routes always pass `resolveChatSessionModel(config, session)` to execution services.

- [ ] **Step 1: Add failing server-owned model tests**

Add request-normalizer and E2E assertions that a body containing `{ model: 'client-model' }` produces no model field and the created session uses the active preset ID/model. Add route tests that per-request model JSON cannot change the model passed to chat, plan, or repo-search execution.

- [ ] **Step 2: Verify RED**

Run: `npm run test -- chat-route-request-normalizers dashboard-status-server`

Expected: FAIL because create and stream routes still read client model strings.

- [ ] **Step 3: Remove model fields completely**

Delete `model` from `ChatSessionCreateRequest` and `parseChatSessionCreateRequest`. Create sessions with:

```ts
modelPresetId: activePreset.id,
model: getConfiguredModel(currentConfig),
```

Replace every chat-backed `reader.optionalString('model')` execution option with `resolveChatSessionModel(config, session)`. Remove `getActiveModel()` and the `model`/`contextWindowTokens` properties from dashboard create payload types/builders. Update all fixtures to include required `modelPresetId`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm run typecheck:test`

Run: `npm run test -- chat-route-request-normalizers dashboard-status-server`

Run: `npm --prefix dashboard test`

Expected: all pass with no remaining client model field in chat-backed API code.

Commit:

```powershell
git add -- src/status-server/chat-route-request-normalizers.ts src/status-server/routes/chat.ts dashboard/src/api.ts dashboard/src/hooks/useChatController.ts tests dashboard/tests
git commit -m "refactor: make chat model selection server owned"
```

---

### Task 5: Split and Mutation-Verify E2E Regressions

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`
- Temporarily mutate and restore: `src/status-server/chat.ts`, `src/status-server/routes/chat.ts`

**Interfaces:**
- Produces explicit `ChatMetadataServerFixture` test class with `start()`, `stop()`, `saveSession()`, and request helpers.
- Produces four independently named E2E tests from the combined regression.

- [ ] **Step 1: Refactor the combined test while GREEN**

Extract lifecycle/config setup into an explicit class without callback injection. Split tests into:

```ts
test('EXL3 chat creation uses server-owned inference metadata', async () => { ... });
test('active model preset sessions expose current model and context', async () => { ... });
test('inactive model preset sessions preserve inference snapshots', async () => { ... });
test('reading an active model preset session does not rewrite snapshots', async () => { ... });
```

Run: `npm run test -- dashboard-status-server`

Expected: PASS.

- [ ] **Step 2: Mutation RED — creation ownership**

Temporarily change creation to store a wrong preset ID/model. Run the single focused test using Node's test-name pattern after `npm run build:test`:

```powershell
node --test --test-name-pattern="EXL3 chat creation uses server-owned inference metadata" dist/tests/dashboard-status-server.test.js
```

Expected: FAIL on model-preset identity/model. Restore production and rerun PASS.

- [ ] **Step 3: Mutation RED — active identity**

Temporarily make active sessions return stored snapshots. Run the active-session test; expect FAIL on current model/context. Restore and rerun PASS.

- [ ] **Step 4: Mutation RED — inactive identity**

Temporarily make inactive sessions use active configuration. Run the inactive-session test; expect FAIL on preserved model/context. Restore and rerun PASS.

- [ ] **Step 5: Mutation RED — non-mutating reads**

Temporarily persist resolved active metadata in `GetChatSessionEndpoint` before responding. Run the non-mutating-read test; expect FAIL on stored snapshot. Restore and rerun PASS.

Store mutation output under `.codex-temp/chat-metadata-mutations/` and delete it after all four RED/GREEN cycles.

- [ ] **Step 6: Commit split tests**

```powershell
git add -- tests/dashboard-status-server.test.ts
git commit -m "test: isolate chat inference metadata regressions"
```

---

### Task 6: Full Validation and Final Drift Audit

**Files:**
- Verify all files changed by Tasks 1-5.

- [ ] **Step 1: Run focused tests**

Run: `npm run test -- contracts-chat chat-sessions-db runtime-db-schema-v33 status-server-chat chat-route-request-normalizers dashboard-status-server`

Expected: zero failures.

- [ ] **Step 2: Run typecheck and dashboard tests**

Run: `npm run typecheck`

Run: `npm --prefix dashboard test`

Expected: exit code 0.

- [ ] **Step 3: Run full tests and coverage**

Run: `npm test`

Run: `npm run test:coverage`

Expected: zero failures and changed branches covered.

- [ ] **Step 4: Audit source and diff**

Use `siftkit summary` on the implementation diff and `siftkit repo-search` to confirm:

- no model-name ownership comparison remains;
- no client model read remains in chat-backed routes/dashboard payloads;
- no nullable config or `150_000` fallback remains in context usage;
- no missing `modelPresetId` fixture remains;
- no cast/`any`/`!`/namespace import/dynamic function passing/compatibility shim was introduced.

- [ ] **Step 5: Clean temporary files and confirm status**

Verify `.codex-temp/chat-metadata-mutations` resolves inside the workspace, remove it, and run `git status --short`. Expected: clean working tree.
