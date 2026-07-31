# Preset Unification — Handoff (plan complete)

Plan: [2026-07-31-preset-unification.md](./2026-07-31-preset-unification.md)
Branch: `feat/preset-unification` (branched from `main` @ `9737aca`)

## Status — all 10 tasks landed

| Task | State | Commit |
|---|---|---|
| 1. `clampToPresetMaxTokens` helper + provider adoption | done | `58a3590` |
| 2. Thread real `SiftConfig` through planner requests | done | `e5a327d` |
| 3. Delete per-request sampler overrides from the client pipeline | done | `07d7360` |
| 4. Repo-task output budgets clamp to preset MaxTokens | done | `6edc1a6` |
| 5. Config overlays replace model / MaxTokens overrides | done | `60c34af` |
| 6. CLI chat reasoning follows the preset | done | `12b558f` |
| 7. Host sync overlays full preset + TTL cache | done | `9eb7823` |
| 8. Chat sessions snapshot the full model preset | done | `b97d337` |
| 9. Passthrough forces preset samplers | done | `5d90ace` |
| 10. Full verification + regression gate | done | `c2613b1` |

Final verification: `npm run typecheck` (includes `eslint .`) clean; `npm test` → 2002 tests, 2000 pass, 0 fail, 2 skipped. Working tree clean.

Two commits from the user landed between task 2 and task 3 and are in the baseline: `ae4bd1f` (managed-llama fixture no longer orphans a process) and `5b8c625` (shared HTTP agent across tests).

## Environment notes that held throughout

1. **The test runner is `node:test`, not vitest.** `import test from 'node:test'` + `assert` from `node:assert/strict`, run via `npm test` (`typecheck:test` → `build:test` → `dist/scripts/run-tests.js`). Single file: `npx tsx --test tests/<file>.test.ts`; single case: add `--test-name-pattern "<substring>"`.
   - Task 7's TTL test uses `mock.timers.enable({ apis: ['Date'] })` + `mock.timers.tick(...)` from `node:test`. Faking only `Date` leaves real timers and real HTTP intact, so the in-flight `/config` fetch is unaffected.
2. **Build test configs with `mockSiftConfig`** from [tests/helpers/mock-config.ts](../../../tests/helpers/mock-config.ts) (re-exported as `mockConfig` from [tests/_runtime-helpers.ts](../../../tests/_runtime-helpers.ts)). `asRuntimeSiftConfig` is the escape hatch when normalization would repair the value under test. That file now also exports **`mockModelPreset(overrides)`** — a fully-populated `ModelRuntimePreset` built from the default preset, used by every chat-session fixture.
   - Normalization **repairs a dangling `ActivePresetId`** (falls back to `Presets[0]`).
   - Normalization also **zeroes the thinking flags when `Reasoning` is not `'on'`**: `ReasoningContent`, `PreserveThinking`, and `MaintainPerStepThinking` are all derived ([normalization.ts:413-415](../../../src/config/normalization.ts#L413-L415)). A fixture that sets `PreserveThinking: true` without `Reasoning: 'on'` silently gets `false`.
3. **`SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN` is 2.5, not 4.** Use `estimateTokenCount(config, text)` from `src/repo-search/prompt-budget.ts`.
4. **Supplying a config to a task loop turns on live tokenize preflight.** Stub servers must **404** the tokenize route (non-transient → immediate estimate fallback). ECONNREFUSED/503 are transient and burn up to 30 s of retries.

## Deviations from the written plan (all committed)

1. **Task 3 — `overrides` bag deleted, not shrunk.** `InferenceRequestInput` carries a required top-level `maxTokens: number`; `buildCommonRequest` reads every other sampler from `input.defaults`.
2. **Task 5 — the `llamaCppOverrides` wire field was flattened too.** The `/summary` HTTP body *is* the serialized `SummaryRequest` ([status-server-api-client.ts:99](../../../src/cli/status-server-api-client.ts#L99)), so keeping a nested wire shape would have needed a translation shim. The field is `llamaCppMaxTokens: number` end to end.
3. **Task 5 — `overlayActivePreset` is exported**, and Tasks 7 use it instead of re-spreading `Server.ModelPresets.Presets`.
4. **Task 7 — the host `Model` is not overlaid when the host reports none.** The plan wrote `Model: hostPreset.Model` unconditionally, which would null out a working local model whenever the host has no model loaded. `buildPresetOverlay` omits the key in that case, preserving the pre-existing fallback.
5. **Task 8 — the two replaced columns are dropped, and legacy rows are migrated rather than orphaned.** The plan offered "keep `model`/`context_window_tokens` written from the snapshot"; that is a shim, so schema **v37** adds `model_preset_json`, backfills it, then drops both columns. Backfill uses the session's own preset from `app_config.server_llama_presets_json` (falling back to the active preset when that preset was deleted) with the row's historical `model`/`context_window_tokens` overlaid — which is exactly what the old two-column snapshot meant. No data loss, and no session is left unreadable.
6. **Task 8 — chat call sites drop the separate `model` argument entirely.** `resolveChatSessionConfig` makes the snapshot preset the active preset, and the engine derives the model from the config (Task 5). `chat-repo-operation-runner.ts` and `routes/chat.ts` now pass only `config:`.
7. **Task 10 — the gate is broader than the plan's two entries.** It also asserts `src/state/chat-sessions.ts` has no `contextWindowTokens` and walks all of `src/**/*.ts` for `llamaCppOverrides`. Both directions of the gate mechanism were verified manually (a pattern known to be present is caught; the banned ones are not).

## What tasks 7-10 changed

**Task 7** (`9eb7823`) — [src/config/host-sync.ts](../../../src/config/host-sync.ts)
- `HostLlamaSettings` → `HostPresetSettings`: the full request-shaping `Pick` of `ModelRuntimePreset` (`Model`, `NumCtx`, `Reasoning`, `ReasoningContent`, `PreserveThinking`, `MaintainPerStepThinking`, `MaxTokens`, `Temperature`, `TopP`, `TopK`, `MinP`, `PresencePenalty`, `RepetitionPenalty`).
- `NumCtx`/`Reasoning` resolve as `Runtime.LlamaCpp` first, then the host preset — a llama host records the launched values on `Runtime.LlamaCpp`; an exl3 host only has them on the preset.
- Cache entries became `{ fetchedAtMs, settings }` with a 60 s TTL (`HOST_SETTINGS_TTL_MS`). `resetHostLlamaSettingsCacheForTests` unchanged.
- The overlay goes through `overlayActivePreset`, plus the unchanged `Runtime.LlamaCpp` `NumCtx`/`Reasoning` write that keeps llama-backend getter priority intact.
- Tests in [tests/host-sync.test.ts](../../../tests/host-sync.test.ts): full-field overlay (asserting `ExternalServerEnabled`/`BaseUrl` stay local), exl3 getters seeing host values, and TTL re-fetch. `makeClientConfig` gained a `presetFields` parameter.

**Task 8** (`b97d337`)
- [src/state/chat-sessions.ts](../../../src/state/chat-sessions.ts): `ChatSession.model`/`contextWindowTokens` → required `modelPreset: ModelRuntimePreset`; `requireContextWindowTokens` → `parseModelPresetSnapshot` (throws `Chat session <id> has no model preset snapshot; re-create the session.`); row schema/read/write use `model_preset_json`.
- [src/state/runtime-db.ts](../../../src/state/runtime-db.ts): `CURRENT_SCHEMA_VERSION` 36 → 37; base `chat_sessions` DDL carries `model_preset_json TEXT`; new `migrateChatSessionsToModelPresetSnapshot`.
- [src/status-server/chat.ts](../../../src/status-server/chat.ts): resolvers read `session.modelPreset`; new `resolveChatSessionConfig`.
- [src/status-server/routes/chat.ts](../../../src/status-server/routes/chat.ts): creation snapshots `activePreset`; the chat engine call passes `config: resolveChatSessionConfig(...)` and no `model`. `toWireChatSession` still derives the wire `model`/`contextWindowTokens` via the resolvers — **no wire change**.
- [src/status-server/chat-repo-operation-runner.ts](../../../src/status-server/chat-repo-operation-runner.ts): same substitution.
- [src/status-server/preset-runner.ts](../../../src/status-server/preset-runner.ts): `applyModelOverrideToConfig(config, request.model)` first, then snapshot and run against that config.
- Tests: new [tests/runtime-db-schema-v37.test.ts](../../../tests/runtime-db-schema-v37.test.ts) (backfill, active-preset fallback, column drop); snapshot round-trip + loud-read tests in [tests/chat-sessions-db.test.ts](../../../tests/chat-sessions-db.test.ts); `resolveChatSessionConfig` cases in [tests/status-server-chat.test.ts](../../../tests/status-server-chat.test.ts); every `ChatSession` fixture across 6 test files rebuilt on `mockModelPreset`.

**Task 9** (`5d90ace`) — [src/status-server/routes/inference-passthrough.ts](../../../src/status-server/routes/inference-passthrough.ts)
- `setNumberDefault` deleted; `translateChatBody` assigns every sampler from `buildPresetRequestDefaults(preset)` and sets `max_tokens = min(caller, preset)`.
- `applyThinkingDefaults` → `applyThinkingSettings`: `chat_template_kwargs` is *replaced*, so a caller cannot turn thinking on against a `Reasoning: 'off'` preset. `preserve_thinking` is gated on `ReasoningContent` too, matching `shouldPreserveThinking` in `chat.ts`.
- The fake llama fixture ([tests/helpers/managed-llama-fixtures.ts](../../../tests/helpers/managed-llama-fixtures.ts)) now echoes the received chat body as `forwardedRequest`, which is what makes the passthrough assertions end-to-end rather than a unit test of a private function.

**Task 10** (`c2613b1`) — new [tests/preset-unification-gate.test.ts](../../../tests/preset-unification-gate.test.ts).

## Sanctioned overrides that remain (by design)

- Summary llama.cpp non-chunk path forces reasoning off ([core-runner.ts:435](../../../src/summary/core-runner.ts#L435)) — untouched.
- Chat sessions may toggle reasoning per session (`session.thinkingEnabled` → `thinkingEnabledOverride`) — untouched.
- Caller-supplied `maxTokens` may only *lower* the preset cap, everywhere.

## Known flake (pre-existing, not caused by this work)

`managed llama readiness wait is serialized by the model request queue` in [tests/repo-search-status-server.test.ts](../../../tests/repo-search-status-server.test.ts) failed once under full-suite concurrency in an earlier session. It passed on every run during tasks 3-10.
