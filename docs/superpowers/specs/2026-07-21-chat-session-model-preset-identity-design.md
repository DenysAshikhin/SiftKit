# Chat Session Model-Preset Identity Design

Date: 2026-07-21
Status: approved design, pending implementation plan

## Goal

Make chat-session inference ownership explicit and stable by storing a model-preset ID instead of inferring ownership from model-name equality. Remove the hardcoded no-config context fallback and replace the combined regression test with independently mutation-verified E2E behaviors.

## Scope

- Add required `modelPresetId` to the shared chat-session contract and SQLite persistence.
- Migrate existing sessions forward by resolving their stored model snapshot to exactly one configured model preset.
- Remove client-provided model selection from chat-session creation and chat/plan/repo-search HTTP requests.
- Resolve the session model and context from its preset identity, using current settings only while that preset is active and stored snapshots otherwise.
- Require valid `SiftConfig` for context usage and wire serialization.
- Split and mutation-verify the previously combined endpoint regression.

## Non-goals

- Do not add a compatibility fallback from `modelPresetId` to model-name matching after migration.
- Do not preserve arbitrary client model overrides.
- Do not redesign CLI-only inference APIs that are not backed by chat sessions.
- Do not alter model-preset IDs, agent preset IDs, output-token limits, or condensation behavior.

## Root Causes

### Model strings are not identity

`resolveChatSessionContextWindow()` currently compares `session.model` to the active preset's `Model`. Model names can be duplicated, renamed, or supplied arbitrarily by an HTTP client. They cannot identify which preset owns the session.

Session creation and streaming endpoints also accept model strings from clients while deriving context and reasoning from server configuration. That permits a request model and its metadata to come from different sources.

### Missing configuration is impossible in production

Every production context-usage and wire-serialization caller already holds a validated `SiftConfig`. The nullable config path exists only for tests and introduced a hardcoded `150_000` fallback that conflicts with the canonical `128_000` default.

### One E2E test hid independent RED states

The existing EXL3 endpoint test asserts creation, reasoning, list synchronization, detail synchronization, historical preservation, and non-mutating reads sequentially. Its initial failure stopped before later assertions, so those behaviors were never independently observed RED.

## Design

### 1. Required model-preset identity

Add `modelPresetId: z.string().min(1)` to `ChatSessionSchema` and the inferred internal session type. Keep `model` as a server-owned snapshot for historical display and inactive-preset execution.

`presetId` remains the agent/operation preset (`chat`, `repo-search`, and similar). `modelPresetId` exclusively identifies the inference model preset.

New sessions always capture:

- `modelPresetId` from `getActiveModelPreset(config).id`;
- `model` from that preset's resolved model;
- `contextWindowTokens` from the canonical configured context;
- `thinkingEnabled` from canonical configured reasoning.

Clients no longer supply any of those inference-owned fields.

### 2. Forward-only SQLite v33 migration

Increment `CURRENT_SCHEMA_VERSION` and rebuild `chat_sessions` with `model_preset_id TEXT NOT NULL`.

Before rebuilding, read the configured model presets and active preset ID directly from the existing `app_config` row. Resolve every existing session as follows:

1. A non-empty stored model must match exactly one configured preset's trimmed `Model` value.
2. A model-less session resolves to the configured active preset.
3. Zero or multiple matches abort migration with an error naming the session ID and model.

The migration writes the resolved ID into the rebuilt table and preserves every other column and related message row. There is no runtime fallback, default ID, or compatibility branch after migration.

### 3. Server-owned request model

Remove `model` from:

- `ChatSessionCreateRequest` and its parser;
- dashboard `buildCreateSessionRequest()` and `createChatSession()` payload;
- chat message, plan, and repo-search request parsers/payloads that currently allow per-request model overrides.

Every chat-backed execution resolves its model explicitly from the session:

- if `session.modelPresetId` equals the active preset ID, use the active preset's current configured model;
- otherwise use the session's stored model snapshot;
- if the inactive snapshot is missing, fail loudly.

The same identity rule resolves context-window display. Active preset edits therefore update model and context together; inactive or deleted presets retain the stored snapshots together.

### 4. Required configuration for context usage

Change `resolveChatSessionContextWindow`, `ContextUsageBuilder`, and `buildContextUsage` to require `SiftConfig`. Remove the no-config path and the inline `150_000` fallback.

Tests that currently pass `null` construct the existing typed test configuration instead. Persistence retains its own schema-level validation; it does not invent model context.

### 5. Independent E2E regressions

Replace the combined endpoint test with independently named tests for:

1. EXL3 creation derives model-preset ID, model, context, and reasoning from the server.
2. An active-preset session exposes current model/context consistently in list, detail, and usage responses.
3. An inactive-preset session preserves model/context snapshots consistently.
4. Reading an active-preset session does not rewrite its stored snapshots.

Reuse an explicit test fixture class for server/config/session lifecycle. Do not pass test callbacks through a generic wrapper.

For each behavior, mutation validation temporarily restores the prior faulty production expression, runs the focused test and records the expected failure, restores the implementation, and reruns GREEN. Temporary mutation files/logs remain under one cleanup directory and are deleted afterward.

## Data Flow

```text
active model preset ID
        |
        +--> session.modelPresetId (required identity)
        +--> session.model (creation snapshot)
        +--> session.contextWindowTokens (creation snapshot)

read/execute session
        |
        +--> ID == active ID --> current active preset model/context
        |
        +--> ID != active ID --> stored model/context snapshots
```

## Failure Behavior

- Ambiguous or unmatched existing session models fail schema migration with the session ID and model.
- Missing active preset configuration continues to fail through canonical config validation.
- An inactive session without a model or valid context snapshot fails instead of receiving an invented default.
- Removed client model fields are rejected as unknown request fields if strict request parsing supports it; otherwise they are removed from typed clients and ignored only by the generic JSON reader without influencing execution.

## Testing (TDD)

Development follows strict red-green-refactor TDD.

Required tests:

- **Contract RED** — chat sessions without `modelPresetId` fail schema parsing.
- **Persistence RED** — `modelPresetId` round-trips and the database column is required.
- **Migration RED** — unique matches and model-less sessions migrate; ambiguous and unmatched models fail loudly.
- **Create API RED** — arbitrary client model input cannot change the server-owned session model.
- **Execution RED** — active identity uses current model/context; inactive identity uses snapshots.
- **Context API RED** — nullable config no longer typechecks and runtime tests use real config.
- **Independent E2E REDs** — each of the four endpoint behaviors fails under its specific prior mutation and passes after restoration.

Validation runs focused contract, database, chat-domain, dashboard endpoint, and dashboard-client tests before full typecheck, full tests, and coverage.

## Risks and Controls

- **Existing ambiguous data:** Migration intentionally fails rather than guessing. The error includes enough identity data for explicit correction.
- **Preset deletion:** Sessions retain model/context snapshots and remain executable while inactive; identity comparison does not require the deleted preset to remain configured.
- **Preset edits:** When the same preset remains active, current model and context replace both snapshots together, preventing mixed metadata.
- **Request contract breadth:** Remove model override fields across every chat-backed route and dashboard caller in one change; no dual API path remains.
- **Migration integrity:** Rebuild inside the existing schema migration transaction/order and preserve foreign-key message rows.

## Consumer Inventory

- `packages/contracts/src/chat.ts`
- `src/state/runtime-db.ts`
- `src/state/chat-sessions.ts`
- `src/status-server/chat-route-request-normalizers.ts`
- `src/status-server/chat.ts`
- `src/status-server/routes/chat.ts`
- `dashboard/src/api.ts`
- `dashboard/src/hooks/useChatController.ts`
- Chat/session contract, database, status-server, and dashboard tests that construct sessions or request payloads.
