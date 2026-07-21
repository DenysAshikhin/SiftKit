# Chat Inference Metadata Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chat session context, reasoning, and tokenizer metadata use the same backend-aware configuration as active inference while preserving snapshots for inactive historical models.

**Architecture:** Add one explicit chat-domain resolver that selects the active configured context only when a session targets the active model, otherwise retaining a valid persisted snapshot. Route serialization, context usage, session creation, reasoning defaults, and tokenizer endpoint gating reuse canonical configuration getters so the server emits one consistent value and the dashboard requires no backend-specific logic.

**Tech Stack:** TypeScript, Node.js HTTP status server, Zod-derived contracts, SQLite session persistence, `node:test`, npm test/build scripts.

## Global Constraints

- Follow red-green-refactor TDD; every production behavior change must first be demonstrated by a failing test.
- Use exact, case-sensitive equality on trimmed model names; aliases and version variants are different models.
- A stored context snapshot is valid only when finite and greater than zero.
- Reads must not mutate persisted sessions or add network/database/tokenizer work beyond existing route behavior.
- Do not add legacy configuration compatibility, type assertions, `any`, non-null assertions, namespace imports, or dynamically passed functions.
- Reuse canonical config getters and existing endpoint fixtures; avoid new abstractions beyond the shared resolver.
- Spec: `docs/superpowers/specs/2026-07-21-chat-inference-metadata-synchronization-design.md`.

---

### Task 1: Resolve Active and Historical Session Contexts

**Files:**
- Modify: `tests/status-server-chat.test.ts`
- Modify: `src/status-server/chat.ts:95-163`

**Interfaces:**
- Consumes: `getActiveModelPreset(config): ModelPreset` and `getConfiguredLlamaNumCtx(config): number` from `src/config/index.ts`.
- Produces: `resolveChatSessionContextWindow(config: SiftConfig | null | undefined, session: ChatSession): number` for usage calculation and route serialization.

- [ ] **Step 1: Write failing resolver tests**

Add tests with real normalized config/session objects covering all branches:

```ts
test('resolveChatSessionContextWindow uses configured context for the active model', () => {
  const config = getDefaultConfig();
  const preset = getActiveModelPreset(config);
  preset.Backend = 'exl3';
  preset.Model = 'active-model';
  preset.NumCtx = 150_000;
  config.Runtime.LlamaCpp.NumCtx = 30_000;

  assert.equal(resolveChatSessionContextWindow(config, {
    id: 'active',
    model: ' active-model ',
    contextWindowTokens: 30_000,
  }), 150_000);
});

test('resolveChatSessionContextWindow preserves an inactive model snapshot', () => {
  const config = getDefaultConfig();
  getActiveModelPreset(config).Model = 'active-model';

  assert.equal(resolveChatSessionContextWindow(config, {
    id: 'historical',
    model: 'historical-model',
    contextWindowTokens: 30_000,
  }), 30_000);
});

test('resolveChatSessionContextWindow falls back to configured context for an invalid snapshot', () => {
  const config = getDefaultConfig();
  getActiveModelPreset(config).NumCtx = 150_000;

  assert.equal(resolveChatSessionContextWindow(config, {
    id: 'invalid',
    model: 'historical-model',
    contextWindowTokens: 0,
  }), 150_000);
});

test('buildContextUsage uses the resolved active-model context', () => {
  const config = getDefaultConfig();
  const preset = getActiveModelPreset(config);
  preset.Model = 'active-model';
  preset.NumCtx = 150_000;

  assert.equal(buildContextUsage(config, {
    id: 'usage',
    model: 'active-model',
    contextWindowTokens: 30_000,
  }).contextWindowTokens, 150_000);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test -- status-server-chat`

Expected: FAIL because `resolveChatSessionContextWindow` is not exported and `buildContextUsage` still returns the persisted 30,000 value.

- [ ] **Step 3: Implement the minimal resolver and reuse it in usage calculation**

In `src/status-server/chat.ts`, import the two canonical getters and add:

```ts
export function resolveChatSessionContextWindow(
  config: SiftConfig | null | undefined,
  session: ChatSession,
): number {
  if (config) {
    const activeModel = getActiveModelPreset(config).Model.trim();
    const sessionModel = typeof session.model === 'string' ? session.model.trim() : '';
    if (sessionModel && sessionModel === activeModel) {
      return getConfiguredLlamaNumCtx(config);
    }
  }

  const persistedContextWindow = Number(session.contextWindowTokens);
  if (Number.isFinite(persistedContextWindow) && persistedContextWindow > 0) {
    return persistedContextWindow;
  }
  return config ? getConfiguredLlamaNumCtx(config) : 150_000;
}
```

Replace the hardcoded calculation in `ContextUsageBuilder.buildTokenTotals()` with:

```ts
const contextWindowTokens = resolveChatSessionContextWindow(this.config, this.session);
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run test -- status-server-chat`

Expected: PASS with all resolver branches and existing usage behavior green.

- [ ] **Step 5: Commit the resolver**

```powershell
git add -- src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "fix: resolve chat context from active backend"
```

---

### Task 2: Synchronize Session Creation and Wire Responses

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `src/status-server/routes/chat.ts:205-227,506-523,653-695`

**Interfaces:**
- Consumes: `resolveChatSessionContextWindow(config, session): number` from Task 1; `getConfiguredLlamaNumCtx(config): number`; `getActiveModelPreset(config): ModelPreset`.
- Produces: all list/detail/create/update chat responses expose a consistent resolved `session.contextWindowTokens` and `contextUsage.contextWindowTokens`.

- [ ] **Step 1: Add failing HTTP regression tests**

Use the existing dashboard server lifecycle. Configure the active preset as EXL3 with model `active-model`, `NumCtx: 150_000`, and `Reasoning: 'off'`, while setting `Runtime.LlamaCpp.NumCtx = 30_000` and `Runtime.LlamaCpp.Reasoning = 'on'`. Add assertions equivalent to:

```ts
const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
  method: 'POST',
  body: JSON.stringify({ title: 'EXL3 context' }),
});
const createdSession = d(created.body.session);
assert.equal(createdSession.contextWindowTokens, 150_000);
assert.equal(createdSession.thinkingEnabled, false);
assert.equal(d(created.body.contextUsage).contextWindowTokens, 150_000);
```

Persist a stale same-model session directly with `saveChatSession(tempRoot, session)` and assert both list and detail responses expose 150,000. Persist a different-model session with a 30,000 snapshot and assert list/detail remain 30,000. Re-read the stale row with `readChatSessionFromPath()` and assert its database value is still 30,000, proving GET did not migrate persistence.

- [ ] **Step 2: Run focused endpoint tests and verify RED**

Run: `npm run test -- dashboard-status-server`

Expected: FAIL because creation and wire serialization expose 30,000 and EXL3 thinking remains enabled.

- [ ] **Step 3: Implement canonical creation and serialization**

Change serialization to accept config explicitly:

```ts
function toWireChatSession(config: SiftConfig, session: ChatSession): WireChatSession {
  return {
    // existing fields unchanged
    contextWindowTokens: resolveChatSessionContextWindow(config, session),
    // existing fields unchanged
  };
}
```

Update both callers to pass `config`. In session creation, resolve the active preset once:

```ts
const activePreset = getActiveModelPreset(currentConfig);
const session: ChatSession = {
  // existing fields unchanged
  model: createRequest.model || activePreset.Model,
  contextWindowTokens: getConfiguredLlamaNumCtx(currentConfig),
  thinkingEnabled: activePreset.Reasoning !== 'off',
  // existing fields unchanged
};
```

Import `getConfiguredLlamaNumCtx` and `resolveChatSessionContextWindow`; remove the now-unused `runtimeLlamaCfg` local.

- [ ] **Step 4: Run focused endpoint tests and verify GREEN**

Run: `npm run test -- dashboard-status-server`

Expected: PASS; active-model session JSON and usage both report 150,000, historical session remains 30,000, and persisted stale data is unchanged.

- [ ] **Step 5: Commit route synchronization**

```powershell
git add -- src/status-server/routes/chat.ts tests/dashboard-status-server.test.ts
git commit -m "fix: synchronize chat session inference metadata"
```

---

### Task 3: Canonicalize Chat Tokenizer BaseURL Gating

**Files:**
- Modify: `tests/dashboard-status-server.test.ts:684-771`
- Modify: `src/status-server/routes/chat.ts:370-373`

**Interfaces:**
- Consumes: `getConfiguredLlamaBaseUrl(config): string`.
- Produces: `getLocalTokenConfig(config)` makes its default-endpoint decision using the identical BaseURL that `LlamaCppClient.countTokens()` will call.

- [ ] **Step 1: Add a failing runtime-override tokenizer regression**

Extend the existing exact-token dashboard test with a llama preset whose `BaseUrl` is `SIFT_DEFAULT_LLAMA_BASE_URL` and a runtime override pointing at the mock tokenizer. Send `assistantContent` through the message endpoint and assert the mock receives `exact route user prompt` and the persisted message records the exact count with `inputTokensEstimated === false`.

This fails under the current reversed precedence because `getLocalTokenConfig()` sees the preset default first and disables tokenizer use even though the canonical runtime URL is the mock server.

- [ ] **Step 2: Run the focused endpoint test and verify RED**

Run: `npm run test -- dashboard-status-server`

Expected: FAIL with estimated token metadata or no request received by the tokenizer mock.

- [ ] **Step 3: Replace duplicated BaseURL resolution**

Import `getConfiguredLlamaBaseUrl` and implement:

```ts
function getLocalTokenConfig(config: SiftConfig): SiftConfig | undefined {
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  return baseUrl === SIFT_DEFAULT_LLAMA_BASE_URL ? undefined : config;
}
```

The route already reads validated effective config, so invalid configuration continues through the existing endpoint error handling.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run test -- dashboard-status-server`

Expected: PASS with the mock tokenizer receiving the request through the runtime override.

- [ ] **Step 5: Commit BaseURL synchronization**

```powershell
git add -- src/status-server/routes/chat.ts tests/dashboard-status-server.test.ts
git commit -m "fix: canonicalize chat tokenizer endpoint"
```

---

### Task 4: Full Validation and Coverage Audit

**Files:**
- Verify: `src/status-server/chat.ts`
- Verify: `src/status-server/routes/chat.ts`
- Verify: `tests/status-server-chat.test.ts`
- Verify: `tests/dashboard-status-server.test.ts`

**Interfaces:**
- Consumes: completed behavior from Tasks 1-3.
- Produces: fresh evidence that type checking, focused regressions, full behavior, and changed resolver branches pass.

- [ ] **Step 1: Run focused regression suites together**

Run: `npm run test -- status-server-chat dashboard-status-server`

Expected: both target suites PASS with zero failures.

- [ ] **Step 2: Run full type checking**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run full tests**

Run: `npm test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 4: Run coverage and inspect changed branches**

Run: `npm run test:coverage`

Expected: exit code 0; `resolveChatSessionContextWindow` has tests for active-model, historical valid snapshot, invalid snapshot with config, and no-config fallback paths. Add only missing branch tests before continuing.

- [ ] **Step 5: Review the final diff for scope and policy compliance**

Run:

```powershell
$diff = git diff HEAD~3 -- src/status-server/chat.ts src/status-server/routes/chat.ts tests/status-server-chat.test.ts tests/dashboard-status-server.test.ts
siftkit summary --text ($diff -join "`n") --question "Return behavioral changes, regression coverage, out-of-scope edits, duplicated logic, type-policy violations, and remaining backend-specific chat metadata reads with exact file:line anchors."
```

Expected: only approved synchronization changes; no casts, `any`, non-null assertions, dynamic function passing, legacy compatibility, or remaining direct `Runtime.LlamaCpp` reads in chat metadata resolution.

- [ ] **Step 6: Commit any validation-only test additions**

If Step 4 required additional branch tests:

```powershell
git add -- tests/status-server-chat.test.ts tests/dashboard-status-server.test.ts
git commit -m "test: cover chat context synchronization branches"
```

If no files changed, do not create an empty commit.
