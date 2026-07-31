# Preset Unification — Handoff (as of Task 6 complete)

Plan: [2026-07-31-preset-unification.md](./2026-07-31-preset-unification.md)
Branch: `feat/preset-unification` (branched from `main` @ `9737aca`)

## Status

| Task | State | Commit |
|---|---|---|
| 1. `clampToPresetMaxTokens` helper + provider adoption | done | `58a3590` |
| 2. Thread real `SiftConfig` through planner requests | done | `e5a327d` |
| 3. Delete per-request sampler overrides from the client pipeline | done | `07d7360` |
| 4. Repo-task output budgets clamp to preset MaxTokens | done | `6edc1a6` |
| 5. Config overlays replace model / MaxTokens overrides | done | `60c34af` |
| 6. CLI chat reasoning follows the preset | done | `12b558f` |
| 7. Host sync overlays full preset + TTL cache | pending | — |
| 8. Chat sessions snapshot the full model preset | pending | — |
| 9. Passthrough forces preset samplers | pending | — |
| 10. Full verification + regression gate | pending | — |

Verification at handoff: `npm run typecheck` (includes `eslint .`) clean, `npm test` → 1988 tests, 1986 pass, 0 fail, 2 skipped.

Two commits from the user landed between task 2 and task 3 and are already in the baseline: `ae4bd1f` (managed-llama fixture no longer orphans a process) and `5b8c625` (shared HTTP agent across tests).

## Plan corrections that still apply to tasks 7-10

Carried forward from the previous handoff, all re-confirmed during tasks 3-6:

1. **The test runner is `node:test`, not vitest.** Tests are `import test from 'node:test'` + `assert` from `node:assert/strict`, run via `npm test` (`typecheck:test` → `build:test` → `dist/scripts/run-tests.js`). Single file: `npx tsx --test tests/<file>.test.ts`; single case: add `--test-name-pattern "<substring>"`.
   - Task 7's `vi.useFakeTimers()` has no equivalent — use `mock.timers` from `node:test` or inject time.
2. **Build test configs with `mockSiftConfig`** from [tests/helpers/mock-config.ts](../../../tests/helpers/mock-config.ts) (re-exported as `mockConfig` from [tests/_runtime-helpers.ts](../../../tests/_runtime-helpers.ts)). `asRuntimeSiftConfig` is the escape hatch when normalization would repair the value under test.
   - Normalization **repairs a dangling `ActivePresetId`** (falls back to `Presets[0]`), so a test cannot construct an orphaned-active-id config through `mockSiftConfig`.
3. **`SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN` is 2.5, not 4.** Use `estimateTokenCount(config, text)` from `src/repo-search/prompt-budget.ts` instead of hardcoded `/4`.
4. **Supplying a config to a task loop turns on live tokenize preflight.** Stub servers must **404** the tokenize route (non-transient → immediate estimate fallback). ECONNREFUSED/503 are transient and burn up to 30 s of retries.
5. Task 5 removed the interim `configuredMaxTokens` branch in `src/providers/llama-cpp.ts` as planned; that file now has one pure `clampToPresetMaxTokens(options.config, dynamicMaxTokens)`.

## Deviations from the written plan (already committed)

1. **Task 3 — `overrides` bag deleted, not shrunk.** The plan kept `overrides: { maxTokens: number }`. A one-field bag named "overrides" no longer describes anything, so `InferenceRequestInput` now carries a required top-level `maxTokens: number` and `buildCommonRequest` reads every other sampler from `input.defaults`. Same contract, one less layer.
2. **Task 5 — the `llamaCppOverrides` wire field was flattened too.** The plan assumed the `/summary` HTTP body was independent of `SummaryRequest`. It is not: [status-server-api-client.ts:99](../../../src/cli/status-server-api-client.ts#L99) does `JSON.stringify(request)` on the `SummaryRequest` itself, so keeping a nested wire shape would have required a translation shim. The body field is now `llamaCppMaxTokens: number` end to end (`SummaryRequest`, `parseSummaryRequest`, `bench/benchmark/*`, the test stub server).
3. **Task 5 — `overlayActivePreset` is exported.** `src/config/overrides.ts` exports the generic overlay alongside the two named helpers so Task 7 can reuse it instead of re-spreading the preset list (see below).

## What tasks 3-6 changed

**Task 3** (`07d7360`)
- [src/llm-protocol/inference-backend.ts](../../../src/llm-protocol/inference-backend.ts): `overrides` object replaced by `maxTokens: number`. The `temperature?: number` at the old line 43 belongs to `InferenceChatRequest` (the outgoing wire shape), not to overrides — left alone.
- [src/llm-protocol/inference-request-builder.ts](../../../src/llm-protocol/inference-request-builder.ts): every sampler and the repetition-penalty key now read `input.defaults`; `max_tokens` reads `input.maxTokens`.
- [src/llm-protocol/llama-cpp-client.ts](../../../src/llm-protocol/llama-cpp-client.ts): six sampler fields deleted from `LlamaCppChatOptions`; the six conditional spreads in `buildChatRequest` collapse to `maxTokens: options.maxTokens`.
- Tests: `tests/inference-request-builder.test.ts` (overrides-bag call sites rewritten; the sampler-override case became "sampling always comes from preset defaults"), `tests/llm-protocol.test.ts` (the `temperature: 0.2` chat option is gone; the body assertion now compares against `getActiveModelPreset(protocolConfig).Temperature`).

**Task 4** (`6edc1a6`)
- [src/repo-search/engine/prompt-preparer.ts](../../../src/repo-search/engine/prompt-preparer.ts): both `getDynamicMaxOutputTokens` calls (initial turn and post-compaction) wrapped in `clampToPresetMaxTokens(this.options.config, …)`.
- [src/repo-search/engine/terminal-synthesizer.ts](../../../src/repo-search/engine/terminal-synthesizer.ts): same wrap on `synthesisMaxTokens`.
- Test: `runTaskLoop clamps planner and terminal synthesis max_tokens to the preset MaxTokens` in [tests/repo-search-loop.core.test.ts](../../../tests/repo-search-loop.core.test.ts) — one loop run (`maxInvalidResponses: 1`) covers both the planner request and the synthesis request, and asserts the dynamic budget would have been larger so the clamp is what is being observed.

**Task 5** (`60c34af`)
- New [src/config/overrides.ts](../../../src/config/overrides.ts): `overlayActivePreset(config, fields)` (targets the preset `getActiveModelPreset` resolves, so it cannot drift from the getter), `applyModelOverrideToConfig`, `applyMaxTokensOverrideToConfig` (throws on non-finite / < 1). All three exported from `src/config/index.ts`.
- [src/repo-search/engine.ts](../../../src/repo-search/engine.ts): `applyModelOverrideToConfig(await applyHostLlamaRuntimeSettings(...), options.model)`; `model` now derives from the config.
- [src/summary/request-runner.ts](../../../src/summary/request-runner.ts) `loadExecutionContext`: host sync → model overlay → MaxTokens overlay → `this.model = getConfiguredModel(this.config)`. This fixes a real ordering bug: the model used to be resolved *before* host sync, so a pass-through host's model was ignored.
- `llamaCppOverrides` threading deleted from `core-runner.ts`, `provider-invoke.ts`, `planner/mode.ts`, and the `overrides` param removed from `generateLlamaCppResponse` / `generateLlamaCppChatResponse`.
- Tests: new [tests/config-overrides.test.ts](../../../tests/config-overrides.test.ts); `summary requests use the host model and the caller MaxTokens overlay` in [tests/runtime-summarize.test.ts](../../../tests/runtime-summarize.test.ts) (verified to fail with the old ordering — it reported `stale-local-model`); `tests/route-request-normalizers.test.ts` and `tests/summary-status-server.test.ts` updated for the flat field.
- Shared fixture change: the stub server's `GET /config` route now ignores the query string, so it can also serve as a pass-through host (`/config?skip_ready=1`). See [tests/_runtime-helpers.ts](../../../tests/_runtime-helpers.ts).

**Task 6** (`12b558f`)
- [src/status-server/preset-runner.ts](../../../src/status-server/preset-runner.ts) `runChatPreset`: one `thinkingEnabled = getConfiguredReasoning(config) !== 'off'` feeds both the ephemeral session literal and the `executeRepoSearch` call.
- Tests in [tests/preset-runner.test.ts](../../../tests/preset-runner.test.ts): a `CapturingEngineService extends StatusEngineService` subclass (override, not an injected function) captures the request; the fixture writes a config with a cli-surfaced clone of the built-in `chat` preset, because the built-in one is `surfaces: ['web']` and `getPresetById` rejects non-cli presets.

## Next step — Task 7

Host sync overhaul in [src/config/host-sync.ts](../../../src/config/host-sync.ts). Current state of that file: it fetches only `{ numCtx, reasoning, model }`, caches them **forever** per base URL (`Map<string, HostLlamaSettings>` with no timestamp), and overlays `Model` onto the active preset plus `NumCtx`/`Reasoning` onto `Runtime.LlamaCpp`.

Task 7 must:
1. Widen the snapshot to the full request-shaping set (`Model`, `NumCtx`, `Reasoning`, `ReasoningContent`, `PreserveThinking`, `MaintainPerStepThinking`, `MaxTokens`, `Temperature`, `TopP`, `TopK`, `MinP`, `PresencePenalty`, `RepetitionPenalty`).
2. Add the 60 s TTL (`{ fetchedAtMs, settings }` cache entries).
3. Keep writing `NumCtx`/`Reasoning` to `Runtime.LlamaCpp` as well, so the llama-backend getter priority is unchanged, while the preset-level overlay is what makes host values visible to the EXL3 getters.

Use `overlayActivePreset` from `src/config/overrides.ts` for the preset write rather than re-spreading `Server.ModelPresets.Presets` — the plan's snippet predates that helper.

Fixtures to extend: [tests/host-sync.test.ts](../../../tests/host-sync.test.ts) already has `makeClientConfig({ externalServer, baseUrl, localNumCtx })` and `startHostConfigServer(body, { status })` with a `requestUrls` log — the TTL test can count entries in `requestUrls` instead of mocking the clock, if driving time proves awkward. `resetHostLlamaSettingsCacheForTests` must keep working (it is called from `tests/runtime-summarize.test.ts` too).

Then Task 8 (chat session full-preset snapshot; depends on Task 5, which is now done), Task 9 (passthrough), Task 10 (gate test + grep sweep + full suite).

## Known flake (pre-existing, not caused by this work)

`managed llama readiness wait is serialized by the model request queue` in [tests/repo-search-status-server.test.ts](../../../tests/repo-search-status-server.test.ts) failed once under full-suite concurrency in an earlier session. It passed on every run during tasks 3-6.
