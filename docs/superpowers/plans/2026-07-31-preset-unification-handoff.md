# Preset Unification — Handoff (as of Task 2 complete)

Plan: [2026-07-31-preset-unification.md](./2026-07-31-preset-unification.md)
Branch: `feat/preset-unification` (branched from `main` @ `9737aca`)

## Status

| Task | State | Commit |
|---|---|---|
| 1. `clampToPresetMaxTokens` helper + provider adoption | done | `58a3590` |
| 2. Thread real `SiftConfig` through planner requests | done | `e5a327d` |
| 3. Delete per-request sampler overrides from the client pipeline | pending | — |
| 4. Repo-task output budgets clamp to preset MaxTokens | pending | — |
| 5. Config overlays replace model / MaxTokens overrides | pending | — |
| 6. CLI chat reasoning follows the preset | pending | — |
| 7. Host sync overlays full preset + TTL cache | pending | — |
| 8. Chat sessions snapshot the full model preset | pending | — |
| 9. Passthrough forces preset samplers | pending | — |
| 10. Full verification + regression gate | pending | — |

Verification at handoff: `npm run typecheck` clean, `npm test` → 1976 tests, 1974 pass, 0 fail, 2 skipped.

## Plan corrections discovered during execution

These are deviations from the written plan that the remaining tasks must also apply.

1. **The test runner is `node:test`, not vitest.** The plan's snippets use `describe/it/expect/vi`. This repo has no vitest dependency. Tests are `import test from 'node:test'` + `assert` from `node:assert/strict`, run via `npm test` (`typecheck:test` → `build:test` → `dist/scripts/run-tests.js`). Fast inner loop for a single file: `npx tsx --test tests/<file>.test.ts`.
   - Task 7's `vi.useFakeTimers()` has no equivalent import — use `node:test`'s `mock.timers` (`import { mock } from 'node:test'`) or drive the TTL by injecting time.
2. **Do not build configs with `getDefaultConfigObject()` in tests.** Use `mockSiftConfig` from [tests/helpers/mock-config.ts](../../../tests/helpers/mock-config.ts) — it merges a `DeepPartial<SiftConfig>` onto the defaults and normalizes. `asRuntimeSiftConfig` is the escape hatch when normalization would repair the value under test (used in `tests/dynamic-output-cap.test.ts` for the `MaxTokens: 0` guard branch).
3. **`SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN` is 2.5, not 4.** Any test that previously passed `config: undefined` estimated tokens at 4 chars/token; once a config is supplied the estimate becomes 2.5 chars/token. Assertions that hardcode `/4` must switch to `estimateTokenCount(config, text)` from `src/repo-search/prompt-budget.ts`.
4. **Supplying a config to a task loop turns on live tokenize preflight.** `PromptPreparer` calls `/tokenize` (llama) at `getConfiguredLlamaBaseUrl(config)`. Consequences for stub-server tests:
   - A **404** from that base URL is non-transient → immediate fallback to the estimate. This is the desired shape for stubs.
   - **ECONNREFUSED / 503** are transient → `retryProviderRequest` retries for up to `DEFAULT_LLAMA_CPP_TOKENIZE_RETRY_MAX_WAIT_MS` (30 s), which will blow test time budgets or reorder request assertions.
   - Fix pattern used: point `Runtime.LlamaCpp.BaseUrl` at a server that 404s the tokenize route, while the planner `baseUrl` option stays on whatever endpoint the test is exercising. `tests/mock-repo-search-loop.test.ts` now has a `startNotFoundServer()` helper for exactly this.
5. **The plan's interim `configuredMaxTokens` expression in Task 1 is wrong.** `Math.max(1, Math.floor(Number(undefined ?? 0) || 0)) || null` evaluates to `1`, not `null`, which would clamp every request to one token. The committed code uses an explicit `options.overrides?.MaxTokens === undefined` check instead. Task 5 deletes this branch entirely.

## What Task 1 changed

- [src/lib/dynamic-output-cap.ts](../../../src/lib/dynamic-output-cap.ts): added `clampToPresetMaxTokens(config, outputTokens)`; returns `outputTokens` untouched when `config` is `undefined`, otherwise `max(1, min(outputTokens, preset.MaxTokens))`.
- [src/providers/llama-cpp.ts](../../../src/providers/llama-cpp.ts): `generateLlamaCppChatResponse` uses the helper; the `overrides.MaxTokens` branch is interim and is deleted in Task 5.
- New: [tests/dynamic-output-cap.test.ts](../../../tests/dynamic-output-cap.test.ts).

## What Task 2 changed

`src/repo-search/planner-protocol.ts`:
- Deleted `buildPlannerRequestConfig` and the `getDefaultConfigObject` import. The synthetic planner config is gone.
- Deleted the hardcoded `temperature: 0.1` / `topP: 0.95` on both the request and the prompt-reserve serialization.
- `PlannerRequestOptions.backend` → `PlannerRequestOptions.config?: SiftConfig`. Same swap on `requestFinishValidation`, `requestApprovalVerdict`, `requestTerminalSynthesis`.
- `requestRepoSearchPlannerProtocolAction` throws `Planner request requires a SiftConfig; only mock runs may omit it.` after the `mockResponses` short-circuit.
- `buildPlannerRequestPromptReserveText` takes `config: SiftConfig | undefined` and derives both the backend (for schema lowering) and the sampler values (via `buildPresetRequestDefaults`) from it, so the reserve mirrors the bytes actually sent.
- `requestApprovalVerdict` wraps its fixed cap in `clampToPresetMaxTokens`.

Callers updated to pass `config: this.options.config`: `engine/task-loop.ts` (planner + verdict), `engine/terminal-synthesizer.ts`, `engine/prompt-preparer.ts`. `ConfiguredApprovalVerdictModelClient` in `repo-search/approval-verdict-probe.ts` now takes `config: SiftConfig`; `src/cli/run-auto-approval-probe.ts` passes it.

Test files touched (all now supply a config on every non-mock path):
`tests/repo-search-planner-protocol.test.ts` (added `buildTestConfig` + `captureChatRequestBody` helpers and the three new assertions from the plan), `tests/repo-search-planner-empty-tools.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/mock-repo-search-loop.test.ts`, `tests/engine-terminal-synthesizer.test.ts`, `tests/planner-streaming-timings.test.ts`, `tests/image-input-surfaces.e2e.test.ts`.

### Deliberate test-fixture decisions worth knowing

- `runTaskLoop uses dynamic max_tokens for planner requests…` and `…for terminal synthesis requests` (both in `tests/repo-search-loop.core.test.ts`) were given a preset with `MaxTokens: 100_000` so they keep asserting the *dynamic* budget rather than the preset cap. Task 4 must add its own clamp coverage rather than repurposing these.
- `tests/engine-terminal-synthesizer.test.ts`'s streaming fixture was flipped to `useEstimatedTokensOnly: true` when the config was added. That flag was previously inert (config was `undefined`), so this preserves the exact prior token-counting path; the stub server serves chat completions only.

## Known flake (pre-existing, not caused by this work)

`managed llama readiness wait is serialized by the model request queue` in [tests/repo-search-status-server.test.ts](../../../tests/repo-search-status-server.test.ts) failed once under full-suite concurrency (~19 s) and passed both in isolation and on the next full-suite run. Timing-sensitive; unrelated to preset threading.

## Next step

Task 3: shrink `InferenceRequestInput.overrides` to `{ maxTokens: number }`, delete the six sampler fields from `LlamaCppChatOptions` and their conditional spreads in `buildChatRequest`, and make `buildCommonRequest` read every sampler from `input.defaults`. Tests: `tests/inference-request-builder.test.ts`, `tests/llm-protocol.test.ts`, `tests/llm-protocol-streaming.test.ts`. Task 2 already removed the only in-repo caller that passed per-request samplers, so this should be a clean deletion.
