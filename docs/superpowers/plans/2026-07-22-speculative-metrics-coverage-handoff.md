# Handoff — Speculative/Duration Metrics Coverage + Usage Type Unification

**Date:** 2026-07-22
**Branch:** `codex/fix-formatron-boundary`
**Landed in:** `48bc16d` (a concurrent session committed this work under an unrelated message — "feat: enhance logging with ServerLogger…"). SiftKit working tree is clean.

Context: this session validated three findings from a `reflect-session-drift` report, then fixed two of them. Findings #3 (no E2E for the metrics chain) and #1 (duplicate `LlamaCppUsage`) are **done**. Finding #2 (duplicated speculative fallback merge) is **open by decision** — see below.

---

## READ FIRST — data-loss incident and recovery

I ran `git checkout -- src/repo-search/planner-protocol.ts` to undo a one-line temporary test sabotage. That discarded the session's entire uncommitted 428-line change to that file. Recovery was successful and is committed, but the residue matters:

**How it was recovered:** rebuilt from `dist/src/repo-search/planner-protocol.js` (the session's own tsc output, backed up before it could be overwritten) plus the emitted `.d.ts`.

**How it was verified** (objective, not eyeballed): recompiled the reconstruction and byte-compared emitted JS to the backup — **identical after normalizing whitespace and trailing commas**, both semantically inert.

**What was restored:**
- `import { lowerResponseFormatForBackend } from '../providers/formatron-schema-lowering.js'`
- `backend: InferenceBackendId` param on `buildPlannerRequestPromptReserveText`, and the `lowerResponseFormatForBackend(options.backend, …)` wrapping
- `actionFromProtocolToolCalls` signature change from `allowedToolNames` to `toolDefinitions` (and the `{ toolDefinitions }` parser call)
- `speculativeAcceptedTokens` / `speculativeGeneratedTokens` on `PlannerActionResponse` and its return

**Residual item — one dead local:** [planner-protocol.ts:485](../../../src/repo-search/planner-protocol.ts#L485)

```ts
const allowedToolNames = toolDefinitions.map((toolDefinition) => toolDefinition.function.name);
```

Computed and never used inside `actionFromProtocolToolCalls`. This was genuinely in the session's source (it compiled because `noUnusedLocals` is not set in `tsconfig.json`). I reproduced it deliberately so the emitted-JS comparison would be exact, rather than silently editing during a recovery. **It should be deleted** — it is provably dead, and it violates the repo's no-cruft directive. Do not confuse it with the same-named, genuinely-used local in `requestRepoSearchPlannerProtocolAction`.

**Lesson for the next session:** never use `git checkout --` to undo an edit on a file with uncommitted work. Revert with the inverse edit. When temporarily sabotaging code to prove a test is RED, use the `Edit` tool both directions.

---

## DONE — Finding #3: E2E coverage for the metrics chain

The defect class being guarded against: a usage field computed upstream but dropped at one of ~8 pass-through hops, invisible until the DB shows zeros.

### SiftKit: `tests/tabby-usage-metrics.e2e.test.ts`

Two tests, each driving a TabbyAPI-shaped `usage` body (`draft_accepted_tokens`, `draft_rejected_tokens`, second-based `prompt_time`/`completion_time`) end to end:

| Test | Chain covered | Asserts |
|---|---|---|
| repo-search | HTTP body → `llama-cpp-client` → `planner-protocol` → `TaskLoop` → `TokenUsageTracker` → scorecard → `execute.ts` → status backend | `scorecard.totals.{speculativeAcceptedTokens,speculativeGeneratedTokens,promptEvalDurationMs,generationDurationMs}` + terminal status post |
| summary | HTTP body → `providers/llama-cpp` → `provider-invoke` → `core-runner` → `request-runner` | `deferredMetadata.speculative*` on the terminal status post |

Fixture values: 36 accepted / 9 rejected → 36 accepted, 45 generated; `prompt_time: 0.05`/`completion_time: 0.25` → 50 ms / 250 ms.

**Verified RED** by sabotaging three separate hops (`planner-protocol.ts`, `provider-invoke.ts`, `provider-helpers.ts`): failed with `actual: 0, expected: 50` and `actual: null, expected: 36`, then passed on revert.

### TabbyAPI: `tests/test_usage_stats.py` — **UNCOMMITTED**

11 tests over `get_usage_stats` / `aggregate_usage_stats` in `endpoints/OAI/utils/common_.py`: rounding of fractional `cached_tokens`, absent-vs-zero draft counters, partially-reported counters across generations, aggregation sums, and `model_dump()` field names.

**Verified RED**: 4 failed against a sabotaged patch, 11 pass on revert.

Checked and cleared: `prompt_tokens_details=usl[0].prompt_tokens_details` in `aggregate_usage_stats` looks like a missed sum but is correct — it matches the existing `prompt_tokens = usl[0].prompt_tokens` convention, since n>1 generations share one prompt. Pinned by `test_draft_counters_sum_while_prompt_stats_come_from_the_shared_prompt`.

**Run it** (system Python lacks the deps — use the interpreter the exl3 preset is configured with):

```
cd ../TabbyAPI && "C:/envs/rl310/Scripts/python.exe" -m pytest tests/test_usage_stats.py -q
```

**Action needed:** `../TabbyAPI` still has uncommitted work — `backends/exllamav3/{grammar,model}.py`, `endpoints/OAI/types/common.py`, `endpoints/OAI/utils/common_.py`, plus untracked `tests/test_usage_stats.py` and `tests/test_grammar_filter_cache.py`. That repo is not managed by the session that committed the SiftKit side. **Commit it or it is at risk.**

---

## DONE — Finding #1: `LlamaCppUsage` unified

Deleted the provider-local `LlamaCppUsage` in `src/providers/llama-cpp.ts` and the 10-line field-by-field copy. The provider now imports the protocol type and passes usage through:

```ts
const usage: LlamaCppUsage | null = hasUsageValue(response.usage) || thinkingTokens !== null
  ? { ...response.usage, thinkingTokens }
  : null;
```

`thinkingTokens` is the only override (the provider may derive it by tokenizing reasoning text when the server omits it). The provider type had exactly one real consumer — `LlamaCppGenerateResult` → `src/summary/provider-invoke.ts`. `tests/agent-loop.test.ts` imports the *protocol* type, so it was unaffected.

Only visible behavior change: `outputTokens` is now present on the provider result. TDD order held — the two `assert.deepEqual` shape assertions in `tests/runtime-provider-llama.test.ts` gained `outputTokens: 45` first and were watched to fail, then the refactor made them pass.

---

## DONE — Finding #2: duplicated speculative fallback merge

Collapsed. All five sites now call one `resolveSessionSpeculativeMetrics(ctx, cursor, fallback)` in `src/status-server/routes/chat.ts` and spread the result; the usage sites pass the usage partial, the three scorecard sites pass `readScorecardSpeculativeMetrics(result?.scorecard)`. `readManagedLlamaSessionSpeculativeMetrics` folded into the resolver and is gone.

Coverage came first: `tests/chat-speculative-fallback.e2e.test.ts` drives all five routes — `/messages`, `/messages/stream`, `/plan`, `/plan/stream`, `/repo-search/stream` — against a stub backend reporting `draft_accepted_tokens`, with no managed llama tracked, and asserts the persisted assistant message carries 36/45. **Verified RED per site** by neutering each fallback argument in turn; only the sites left intact stayed green.

The scorecard→speculative derivation has exactly one definition (`readScorecardSpeculativeMetrics`); the two `ChatUsage` literals read from it instead of re-spelling `getScorecardTotal`. Merged values are assigned field-by-field, not spread, so the persisted-telemetry options keep excess-property checking.

### Original analysis (kept — it explains the shape of the fix)

Five sites in `src/status-server/routes/chat.ts` repeated "tracker wins, scorecard fills": lines **839**, **1039**, **1195**, **1368**, **1602**, in two spellings.

**Not urgent — the original finding's rationale was wrong.** It claimed the two spellings have "subtly different null-vs-0 semantics". They do not:

- At 839/1039, `usage.speculativeAcceptedTokens` **is** `getScorecardTotal(result?.scorecard, 'speculativeAcceptedTokens')`, assigned at lines 803 and 998.
- `getScorecardTotal` returns `number | null` ([chat.ts:685](../../../src/status-server/chat.ts#L685)), not a number.
- The trailing `?? null` exists only because `usage` is `Partial<ChatUsage>` and is `{}` in the `usesProvidedAssistantContent` branch — it converts `undefined` → `null`.

All five sites implement one identical policy. The concern is future drift, not a live bug.

**The originally proposed fix does not compile.** Threading the scorecard into `readManagedLlamaSessionSpeculativeMetrics(ctx, cursor, scorecard)` ([chat.ts:495](../../../src/status-server/routes/chat.ts#L495)) fails at sites 839/1039: `result` is block-scoped inside the `else` (declared at [chat.ts:781](../../../src/status-server/routes/chat.ts#L781) and 954) and is out of scope at the merge point. That is exactly why those two sites read through `usage` instead.

**If you do fix it,** the helper must take the two resolved fallback numbers (or the `usage` partial), not the scorecard. And note there is currently **no test coverage for the fallback branch at all**: the only speculative E2E, `tests/status-server-speculative-metrics.test.ts`, posts `speculativeAcceptedTokens: null` at lines 194-195 and asserts the *tracker* values (58/258) win over 47/47 — it never exercises the usage-derived path. Write that test before refactoring.

---

## Also noted, not acted on

The per-field fan-out is heavier than the original report stated: adding these two metrics touched **14** files, not ~10 — `llm-protocol/types.ts`, `llama-cpp-client.ts`, `lib/provider-helpers.ts`, `providers/llama-cpp.ts`, `summary/provider-invoke.ts`, `core-runner.ts`, `request-runner.ts`, `repo-search/execute.ts`, `engine.ts`, `engine/task-loop.ts`, `engine/token-usage.ts`, `status-server/repo-search-scorecard-types.ts`, `status-server/chat.ts`, `status-server/routes/chat.ts`. A shared usage-metrics record threaded through the layers would collapse most of these hops. Pre-existing architecture; out of scope here.

---

## Verification

```
npm test                    # 1401 tests, 1399 pass, 0 fail, 2 skipped
npm run typecheck:test      # clean
cd ../TabbyAPI && "C:/envs/rl310/Scripts/python.exe" -m pytest tests/test_usage_stats.py -q   # 11 passed
```

Full SiftKit suite was green after all changes.

## Next actions

- [x] Delete the dead `allowedToolNames` local at [planner-protocol.ts:485](../../../src/repo-search/planner-protocol.ts#L485)
- [ ] Commit the `../TabbyAPI` working tree (source patch + both new test files)
- [x] Cover the chat-route fallback branch with a test, then collapse the five sites (#2)
