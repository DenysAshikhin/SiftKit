# Chat Inference Metadata Synchronization Design

Date: 2026-07-21
Status: approved design, pending implementation plan

## Goal

Make Chat report and initialize inference metadata from the same backend-aware configuration used by the active inference runtime. An EXL3 session configured for a 150,000-token context must not display a stale llama.cpp value such as 30,000 tokens.

## Scope

- Resolve new chat-session context windows through the canonical backend-aware configuration getter.
- Resolve wire-level and context-usage values dynamically when a persisted session still targets the active model.
- Preserve the stored context-window snapshot when a session targets a different model that is no longer active.
- Initialize the thinking toggle from the active model preset's reasoning setting.
- Replace duplicated chat tokenizer BaseURL precedence with the canonical backend-aware getter.
- Cover EXL3, llama.cpp runtime overrides, stale current-model sessions, and historical different-model sessions with regression tests.

## Non-goals

- Do not rewrite every persisted chat-session row.
- Do not change model context limits, output-token limits, condensation behavior, or inference request construction.
- Do not add compatibility branches for removed configuration shapes.
- Do not change the Repo Search agent preset; it does not own the model context window.

## Root Cause

`src/status-server/routes/chat.ts` creates sessions from `currentConfig.Runtime.LlamaCpp.NumCtx` and `currentConfig.Runtime.LlamaCpp.Reasoning`. Those fields describe llama.cpp launch state, not the active backend in general. When EXL3 is active, stale llama.cpp runtime values can remain present even though `getConfiguredLlamaNumCtx()` correctly resolves the active EXL3 preset.

The created `contextWindowTokens` value is persisted and later reused by `ContextUsageBuilder`, so the dashboard faithfully renders the incorrect snapshot. The same direct runtime access enables thinking for EXL3 whenever `Runtime.LlamaCpp.Reasoning` is absent, even if the active EXL3 preset explicitly disables reasoning.

`getLocalTokenConfig()` also duplicates BaseURL precedence instead of using `getConfiguredLlamaBaseUrl()`, creating another point where chat can diverge from inference configuration.

## Design

### 1. One backend-aware context resolver

Add a small explicit resolver in the chat domain that accepts `SiftConfig` and `ChatSession`.

- Compare trimmed model strings with exact, case-sensitive equality; aliases and version variants are different models.
- If the session model equals the active preset model, return `getConfiguredLlamaNumCtx(config)`.
- If the session model differs from the active preset model, return the persisted `session.contextWindowTokens` snapshot only when it is finite and greater than zero.
- If no usable snapshot exists, use the canonical configured context window.

This keeps active sessions synchronized immediately without corrupting historical sessions created for another model.

### 2. Synchronize creation and wire responses

New sessions store `getConfiguredLlamaNumCtx(currentConfig)` rather than reading `Runtime.LlamaCpp.NumCtx` directly.

Every chat-session response that exposes `contextWindowTokens` uses the resolver. Selected-session `contextUsage` uses the same resolved value. The database value remains a creation-time snapshot; read operations do not mutate persistence.

### 3. Synchronize reasoning

New sessions initialize `thinkingEnabled` from `getActiveModelPreset(currentConfig).Reasoning !== 'off'`. Normalized preset schemas reject unsupported reasoning values; an omitted optional value retains the existing enabled default. This matches the existing reasoning-retention and replay policies and works for both EXL3 and llama.cpp presets.

### 4. Synchronize tokenizer endpoint resolution

`getLocalTokenConfig()` uses `getConfiguredLlamaBaseUrl(config)` instead of reimplementing backend precedence. Missing configuration retains the current null/error handling contract.

### 5. Keep responsibilities separate

- Model presets and canonical config getters decide active inference settings.
- Chat sessions retain historical snapshots.
- The chat resolver decides whether the active setting or historical snapshot applies.
- Dashboard components render server-provided values without backend-specific logic.

## Behavior Preservation

- llama.cpp sessions continue honoring `Runtime.LlamaCpp.NumCtx` overrides.
- Pass-through host context values continue winning after host synchronization updates the effective config.
- Sessions for inactive models continue displaying their stored context-window snapshot.
- Existing same-model sessions immediately display the canonical active context without a database migration.
- Manual condensation thresholds continue using the displayed context window.

## Testing (TDD)

Development follows red-green-refactor TDD.

Required new tests:

- **EXL3 session creation ignores stale llama runtime metadata** — configure EXL3 with `NumCtx: 150_000` and `Reasoning: 'off'` while `Runtime.LlamaCpp` contains 30,000/on values; assert the created session reports 150,000 and thinking disabled.
- **Existing active-model session is synchronized on read** — persist a same-model session with a stale 30,000 snapshot; assert session JSON and `contextUsage.contextWindowTokens` report 150,000 without rewriting the row.
- **Historical different-model session preserves its snapshot** — persist a different-model session with 30,000; assert reads continue reporting 30,000.
- **llama.cpp runtime override remains authoritative** — assert a llama.cpp active preset uses the resolved runtime or pass-through host `NumCtx` rather than the preset fallback.
- **Canonical tokenizer BaseURL is used** — characterize backend-aware BaseURL precedence at the chat token-count boundary.

Focused endpoint tests run first. Validation then runs type checking, branch coverage for the changed resolver paths, and the full test suite.

Acceptance criteria:

- Session creation continues returning the route's existing server-error response if canonical configuration is invalid.
- Session reads perform only synchronous in-memory field resolution and add no network, database, or tokenizer calls.
- Session JSON and `contextUsage` always expose the same resolved context window.

## Risks and Controls

- **Model-name collisions:** The current session schema stores a model name, not a preset ID. Matching therefore follows the existing model identity contract. Tests cover matching and non-matching names explicitly.
- **Config changes during a session:** A same-model context-size edit intentionally updates the displayed active capacity because it represents the runtime that will receive the next request.
- **Read/write divergence:** Both wire serialization and `ContextUsageBuilder` call the same resolver, preventing two displayed totals for one session.

## Consumer Inventory

- `src/status-server/routes/chat.ts` — session creation, list/detail serialization, tokenizer BaseURL resolution.
- `src/status-server/chat.ts` — context usage calculation and shared resolver.
- `tests/dashboard-status-server.test.ts` — HTTP-level session creation and read regressions.
- Existing configuration getter tests — canonical EXL3 and llama.cpp resolution behavior remains authoritative.
