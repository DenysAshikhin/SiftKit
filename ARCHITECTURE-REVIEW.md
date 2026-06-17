# SiftKit Architecture Review

Outstanding work items only. Resolved findings are deleted as they are fixed, so finding numbers (F-series) and LLM-behavior items (L-series) have gaps. Every claim is `file:line`-backed and should be re-verified against current code before acting, as line numbers and behavior drift.

Original audit date: 2026-06-09.

---

## Findings

### F6. Test architecture: split-brain between `dist` and `src`, and near-zero typechecking of tests

- Test files import **~94 paths from `../dist/...` and ~80 from `../src/...`** — the same suite simultaneously tests compiled output and raw TS. A test passing can mean "current source works" or "whatever was last built works", depending on the file. `build-test.js` mitigates with an mtime stamp, but the mixed convention makes every test's subject ambiguous and blocks coverage tooling from a single view (the `test:coverage` script only includes `dist/**`).
- `tsconfig.test.json` includes `src/**/*.ts` plus only **17 of ~140 test files** (the engine/chat suites added during the repo-search loop decomposition). `npm run typecheck:test` still skips ~88% of the test suite; type errors in those tests surface only at tsx runtime, or never (tsx does not typecheck).

### F11. Dead code and "legacy" constants that violate the project's no-legacy rule

- `src/llama-cpp-bridge.ts` (107 lines) has **zero importers** in `src/`, `tests/`, or `scripts/`.
- `src/config/constants.ts` exports `SIFT_LEGACY_DEFAULT_NUM_CTX`, `SIFT_LEGACY_DERIVED_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_MODEL`, `SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS` — named legacy-compat values still re-exported through `src/config/index.ts`, against the stated "no legacy compatibility" rule.
- `SIFTKIT_VERSION = '0.1.0'` (`src/config/constants.ts:1`) duplicates `package.json` `version` by hand.
- `tsconfig.json:18` includes `test-full.ts`, which does not exist.
- `src/execution-lock.ts` and `src/config/execution-lease.ts` existed largely to coordinate the now-removed client/server split-brain execution; with the server as sole engine owner they are intra-process-only serialization and candidates for deletion (still imported by `summary/core.ts`, `eval.ts`, `install.ts`).

### F14. Test architecture is inverted and self-undermining

- The dominant harness is `tests/_runtime-helpers.ts` — 1,573 lines, opening with `// @ts-nocheck — Shared runtime test infrastructure. Full typing deferred.` The shared infrastructure for ~30 runtime test files is untyped, in a repo whose rules require strict typing and near-100% branch coverage.
- Mixed `dist`/`src` imports (F6) make every test's subject ambiguous.
- Giant end-to-end tests dominate (2,000+-line `dashboard-status-server.test.ts` and `repo-search-loop.core.test.ts`, tests that boot the real HTTP server + sqlite). The repo-search loop decomposition and the 2026-06-12 route/endpoint split added unit seams; the giant E2E suites have not yet been rebalanced onto them.
- Test seams ship inside production modules: `src/summary/mock.ts` (`SIFTKIT_TEST_PROVIDER_BEHAVIOR`, `SIFTKIT_TEST_TOKEN`), and mock command results (`findMockResult`, `src/repo-search/engine/command-execution.ts`) live in the production execution path.
- Timing-sensitive tests flake under load: `tests/model-request-queue.test.ts` asserts ~30ms queue-timeout windows and intermittently fails in full-suite runs while passing in isolation; the managed-llama startup/idle tests have similarly flaked under c8 instrumentation.

### F15. Benchmark/eval residual in `src` and harness duplication

The packaging half is done: `src/benchmark/`, the repro scripts, and `src/benchmark-matrix/` are relocated to the non-shipped `bench/` tree and the npm `files` whitelist is corrected. Remaining:

- `src/eval.ts` and `src/benchmark-spec-settings.ts` are still in the shipping `src/` graph (server/dashboard-wired). Relocating them belongs to the full server/workspace split, not the standalone bench move.
- `bench/benchmark/` and `bench/benchmark-matrix/` still duplicate each other's `args.ts`/`interrupt.ts`/`runner.ts`/`types.ts` modules (parallel roles). Factor the shared pieces into common bench utilities.

### F16. Dashboard monolith and styling sprawl

`dashboard/src/App.tsx` is 1,341 lines; `styles.css` 1,486 lines alongside a parallel `styles/` directory. `dashboard/src/types.ts` (429 lines) still hand-mirrors server payload shapes (the stale `types.d.ts` copy is gone, and config types are now shared, but session/run/preset payloads remain duplicated). The dashboard has its own `node_modules`/build but no shared contract with the server it talks to — every API change is a manual two-sided edit verified only by integration tests.

### F17. God-function residual

`SummaryPlannerLoopRuntime.requestProviderAction` (`src/summary/planner/mode.ts:468`) is ~120 lines — above the 90-line bar `tests/god-function-regression.test.ts` holds its sibling methods to, and absent from the guard's limit list. Split it and add it to the regression guard.

---

# Part 2 — LLM-behavior analysis

## L1. Managed llama-server configuration issues

`buildManagedLlamaArgs` (`src/status-server/managed-llama.ts:674-679`) launches `llama-server` with a single sampling profile from the active managed preset (`--temp`, `--top-p`, `--top-k`, `--presence-penalty`, `--repeat-penalty` — values now config-driven rather than hardcoded; defaults remain temp 0.7 / top-p 0.8 / presence-penalty 1.5).

**(a) One global sampling profile for all request types.**
- Why it's an issue: SiftKit serves at least four distinct workloads through this one server — strict-JSON planner actions, structured-output extraction, finish-validation verdicts, and free-prose synthesis/chat. These have opposite sampling needs: JSON/tool-call decoding wants near-greedy determinism (temp ≤0.3) so the action parser sees the same shape every turn; prose wants the creative profile. One profile means at least one class is always mis-sampled.
- Why it's an issue: a temp-0.7/top-p-0.8 planner is *nondeterministically* wrong — the same repo-search question can produce a clean run today and an invalid-action retry spiral tomorrow, which makes loop failures unreproducible and the benchmark numbers noisy.

**(b) Presence penalty 1.5 (default) applied to JSON-emitting loops.**
- Why it's an issue: presence penalty subtracts logit mass from every token that has *already appeared* in the output. Valid planner output is forced to re-emit the same structural tokens every turn (`"action"`, `"command"`, braces, quotes, the tool-name strings). Penalizing exactly those tokens pushes the sampler toward paraphrased keys, dropped quotes, or switching to prose mid-object — i.e. malformed actions. (1.5 is inside Qwen's anti-repetition guidance, but that guidance targets free-text repetition in quantized models, not schema-constrained output.)
- Why it's an issue: the codebase already pays for this downstream — `jsonrepair`, first-balanced-`{}` extraction, runaway-structural-tail truncation, token-repetition stream guards, and a 3-strike invalid-response ladder all exist to absorb malformed output that the sampling profile makes more likely. The mitigation stack is evidence the cause was never addressed.

**(c) Sampling configured in two places with silent precedence.**
- Why it's an issue: the server CLI args set one profile at launch, while providers also send per-request `temperature`/`top_p`/penalties from `Runtime.LlamaCpp` config; in llama.cpp, request parameters override CLI. So the dashboard's managed-preset values and what a given request actually used can differ silently — when a model misbehaves, the operator debugs against settings that weren't in effect.
- Why it's an issue: two writable sources with no reconciliation means a config edit in one place (e.g. lowering temperature in the managed preset) can be invisibly negated by the other, making tuning experiments draw wrong conclusions.

**(d) Default context split: `NumCtx` 150,000 with `ParallelSlots` 1 on a quantized 35B model.**
- Why it's an issue: every flow (summary, repo-search, chat) serializes through one slot, so a long repo-search run blocks chat and summary requests for its full duration; callers experience timeouts that look like model failures (and the CLI's fail-closed posture turns them into hard errors).
- Why it's an issue: small quantized models degrade measurably at long effective context even when the window nominally fits; defaulting the planner loop's budget math to the full 150k (minus a 15% thinking buffer) encourages transcripts in the quality-degradation zone instead of compacting earlier — feeding the L3/L5 loop pathologies.

## L2. Repo-search finish gate: prompt and code contradict each other, and the code's logic is inverted

The system prompt (`src/repo-search/prompts.ts:247`) promises: *"Minimum 5 tool-call turns before finish. Early finish is rejected with: 'that was a shallow search…'"*. In code:

- That rejection message exists nowhere; `minToolCallsBeforeFinish` is computed and logged (`src/repo-search/engine/task-loop.ts`) but never enforced.
- The actual gate, `evaluateFinishAttempt` (`src/tool-loop-governor.ts:195`), **allows** a finish with *zero* evidence-bearing tool calls or no `file:line` anchors (`if (!outputHasAnchors || supportedCalls.length === 0) return { allowed: true }`, line 203), **rejects** exactly the case of an anchored answer backed by one evidence-bearing call (line 209), and its final "no evidence" rejection branch (line 215) is unreachable dead code.

Why it's an issue:
- A compliant model wastes ≥5 calls on trivial questions; the filler calls it invents to satisfy the quota are near-duplicates, which trip the duplicate detector (L3) — the quality rule directly produces the punished behavior.
- A non-compliant model can finish with *zero* evidence, and nothing stops it — the exact fabrication scenario the gate exists to prevent ships through unimpeded, then gets validated against an empty evidence set.
- The inverted branch punishes the well-behaved case (anchored answer, one evidence-bearing call) with an extra rejection round, adding turns and tokens to *good* runs.
- Telling the model about a rejection that never comes is a false environment fact; models that probe and find one rule unenforced generalize, weakening adherence to the rules that are enforced.

## L3. The loop manufactures the stagnation it punishes

For a simple question ("where is X defined"), policy demands more search turns than there is information: prompt requires ≥3 rg calls among the first 5 and ≥5 turns before finish; duplicates are auto-rejected; 5 consecutive duplicates (`DUPLICATE_FORCE_THRESHOLD`) or 10 zero-output turns trigger forced-finish mode with adversarial countdowns injected as user messages ("Forced finish mode active. Return a finish action now. Attempts remaining: N."). A small quantized model that found the answer on turn 2 has nowhere legal to go: it pads with near-duplicate searches → gets "duplicate command requested xN. Issue a different/unique tool call" rejections → drifts toward the forced-finish spiral.

Why it's an issue:
- Once information is exhausted, the only available "legal" actions are duplicates or irrelevant searches — the policy converts a correct early answer into either punishment rounds or evidence diluted with off-target results, and the off-target results then feed the final answer.
- A transcript dense with rejection/countdown messages is exactly the conversational texture small models handle worst: it measurably increases looping, apologizing, and panic fabrication in the final output. The harness manufactures that texture on easy tasks, where it should be rarest.
- Norm: scale minimum-effort requirements with question complexity, or gate on evidence sufficiency only — not fixed call counts.

## L4. Conversation history is mutated in place between turns

Two mechanisms rewrite already-sent messages inside the repo-search loop (and the same pattern exists in the summary planner, `src/summary/planner/mode.ts`):

- On repeated duplicates, the *previous* tool-result message is overwritten with "duplicate command requested xN" (`src/repo-search/engine/transcript-manager.ts:77-78`, driven by `tool-action-processor.ts`) — earlier evidence the model saw is replaced.
- Forced-finish countdowns upsert a trailing user message in place (`upsertTrailingUserMessage`, `src/repo-search/engine/transcript-manager.ts:86`; same helper used by the summary planner runtime).

Why it's an issue (norm is append-only transcripts):
- Editing an early message invalidates the llama.cpp prompt-cache prefix from that point on, forcing re-evaluation of up to ~100k tokens of context on every subsequent turn — on local hardware this is the difference between sub-second and tens-of-seconds prompt processing, and it defeats `cache_prompt` entirely.
- The model's own earlier replies now reference evidence that no longer exists in the transcript. Its rational recovery move is to re-run the vanished command — which is a duplicate, which is punished, which deepens the spiral. Alternatively it distrusts the transcript and restates the evidence from memory, i.e. fabricates.

## L5. Context compaction can produce protocol-invalid transcripts

`compactPlannerMessagesOnce` (`src/repo-search/prompt-budget.ts`) selects messages to keep purely by greedy token-fit (system + last user + newest-first whatever fits). There is no constraint keeping an `assistant.tool_calls` message and its `role:"tool"` response together.

Why it's an issue:
- Compaction can emit a `tool` message whose `tool_call_id` has no preceding assistant tool call — invalid under the OpenAI chat schema. llama.cpp jinja chat templates either throw (the request fails exactly when the loop is deepest into a task) or silently misrender, leaving tool output attributed to nobody; the model then misattributes or ignores evidence it actually gathered.
- The "[COMPRESSED HISTORICAL EVIDENCE]" digest is injected as an **assistant** message — fabricated assistant speech. The model sees itself having "said" a harness notice, which both normalizes emitting meta-text in its own replies and lets finish-validation read the digest as model-claimed evidence. Norm: system/user role for harness notices.
- The greedy fit re-renders and re-tokenizes the whole transcript over HTTP for every candidate message (O(n) tokenize calls, 10s timeout each). Compaction runs precisely when the context is fullest, so the worst-case latency lands at the most latency-sensitive moment of a run.

## L6. Dual action protocol with permissive parsing (repo-search loop)

The repo-search system prompt orders "Return ONE valid JSON object — no markdown fences" (JSON-in-content protocol) while the same request registers native tool definitions; the parser then accepts native `tool_calls`, raw JSON in content, the first balanced `{…}` found anywhere in prose, and `jsonrepair`'d fragments. The summary planner now requests grammar-constrained decoding (`structuredOutput: { kind: 'siftkit-planner-action-json' }`, `src/summary/planner/mode.ts:526`); the repo-search planner request (`src/repo-search/planner-protocol.ts:410`) still does not.

Why it's an issue:
- The two protocols conflict at the template level: with native tool definitions registered, the chat template formats the conversation the way the model was *trained* to emit `tool_calls`; instructing it to instead write raw JSON into `content` fights that training distribution and raises malformed-output rates on its own.
- Every format variant the parser tolerates becomes few-shot precedent in the transcript. A model that drifted once (prose-wrapped JSON, repaired fragment) sees its drift accepted and replayed, so drift compounds across turns instead of self-correcting.
- Silent repair hides the failure signal: metrics count the turn as a successful action, so systematic prompt/sampling problems (see L1b) never surface — nothing forces a root-cause fix.
- Norm: one protocol per loop — native tool-calling exclusively, or grammar-constrained decoding (llama.cpp grammar / `response_format`) that makes invalid actions unrepresentable instead of repairing them post-hoc. The summary planner shows the target state; the repo-search loop should follow.

## L7. Harness narration is written into the assistant's own messages

When stream guards fire, the recorded assistant message becomes `"SiftKit stopped the planner stream early: <reason>.\n<truncated content>"` (`src/repo-search/planner-protocol.ts:518`). That text is replayed on subsequent turns as something the assistant said.

Why it's an issue:
- The model is conditioned on its "own" prior output containing third-person narration about itself; mimicking its own transcript is exactly what next-token prediction does, so later turns start emitting similar meta-text into answers.
- Finish-validation and terminal-synthesis prompts feed the transcript back as evidence — harness artifacts get weighed as if the model asserted them, skewing pass/fail verdicts and the salvage answer.
- Norm: harness interventions go in `system`/`user` messages or out-of-band metadata, never inside assistant content.

## L8. Default chat system prompt is a five-word fragment

`DEFAULT_CHAT_SYSTEM_PROMPT = 'general, coder friendly assistant'` (`src/status-server/chat.ts:21`). Not a sentence, no behavioral contract, no tool guidance, no output expectations.

Why it's an issue:
- Small quantized local models are the population most dependent on explicit system-prompt steering; with a five-word fragment, output format, verbosity, tool-usage judgment, and refusal behavior are all left to sampling noise — the same question produces materially different behavior session to session, which users read as flakiness.
- The fragment isn't even grammatical instruction ("general, coder friendly assistant" is a noun phrase); weak/ambiguous system text measurably reduces instruction-following on whatever *is* appended after it (e.g. the web-grounding instruction block from L11 inherits a degraded frame).
- The contrast with repo-search (60 lines of hard constraints) means switching surface/preset swings the model between over- and under-constrained regimes; both extremes diverge from the norm of concise but complete role + capability + format instructions.

## L9. Cross-turn tool replay substitutes truncated UI snippets for full outputs

(The fictitious `persisted_tool_call` replay tool was removed with the F13 unification — replay now reconstructs real tool names via the shared `llm-protocol` builder. The output-substitution half remains.)

Replayed tool outputs fall back to `toolCallOutputSnippet` — a 200-character UI snippet ending in `...` — whenever the full `toolCallOutput` is absent (`src/status-server/chat.ts:64,262,298`; snippet produced at `chat.ts:711`).

Why it's an issue:
- The model believes it already holds complete evidence and answers from an ellipsized fragment instead of re-fetching — confident wrong answers grounded in text that was cut mid-result.
- Norm: replay full tool outputs, or clearly label truncated context as truncated so the model knows to re-fetch.

## L10. Chat "condense" is a no-op for the model — and the context meter is char-estimated in both directions

- `condenseChatSession` (`src/status-server/chat.ts:~548`) marks older messages `compressedIntoSummary: true` and stores a `condensedSummary`. **No prompt builder reads either field**: `buildChatHistoryMessages` iterates all `session.messages` with no `compressedIntoSummary` filter, and `condensedSummary` is never injected into any prompt (verified by repo-wide search — it is only persisted/reset).
  - Why it's an issue: pressing "condense" changes nothing the model sees — the full history still replays, so the overflow behavior the user tried to fix persists, now behind UI state claiming it was handled. Debugging "why is the model still confused after condensing" is unwinnable because the feature is cosmetic.
- The "summary" itself, were it ever used, is not a summary: it is the **last 2,400 characters** of a `role: content` dump (tool outputs excluded), typically starting mid-sentence.
  - Why it's an issue: if this is ever wired in, the model's entire memory of the conversation becomes a ~1k-token arbitrary tail with no tool evidence — earlier commitments, constraints, and facts vanish without the model being told, so it contradicts its own prior answers. Ironic given that LLM summarization is the product's core competency.
- Context accounting: `ContextUsageBuilder` (`src/status-server/chat.ts`) now follows the configured `NumCtx` (both default 150,000), but usage is still char-estimated where recorded token counts are missing, and per-message estimates include thinking tokens that are *never replayed* (history drops `assistant_thinking`); `shouldCondense` triggers at 10% remaining of that estimate.
  - Why it's an issue: a char-based estimate can show green while the real rendered prompt already exceeds the server's window. llama.cpp then truncates or rejects: truncation typically eats the *front* of the prompt — the system prompt and earliest instructions — so the model silently loses its persona/format contract and "goes silly" in ways nothing in the UI explains.
  - Why it's an issue: counting never-replayed thinking tokens inflates usage in the other direction, so condense warnings can also fire far too early — the meter is wrong in both directions, making its one job (triggering condensation at the right time) unreliable.

## L11. Web grounding policy forbids answering from memory — for every message in a web-enabled session

`CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION` mandates "Run web_search before answering. Web-enabled chat is not allowed to answer from memory alone", and finish is rejected up to 3 times until grounded.

Why it's an issue:
- The trigger is a session flag, not claim type: "thanks, reformat that as a table" in a web-enabled session forces a web search the answer doesn't need — wasted latency and quota (the providers are metered), plus irrelevant search results entering context where they can contaminate the actual reformatting task.
- The forced search collides with the duplicate-query rejection: a conversational turn has no natural query, so the model improvises one close to a previous search, gets rejected, retries, and can burn all 3 finish rejections on a message that needed zero evidence — surfacing to the user as the model refusing or stalling on a trivial request.
- The anti-hallucination intent is right; norm is conditioning grounding requirements on whether the answer makes factual claims.

---

## Priority order (highest leverage first)

1. Dead-code sweep: `llama-cpp-bridge.ts`, `SIFT_LEGACY_*`, `execution-lock`/`execution-lease`, `test-full.ts` include (F11).
2. Unit-test pyramid recovery on the new endpoint/runner seams; type the `@ts-nocheck` runtime harness (F6, F14).
3. Dashboard de-monolith: split `App.tsx`/`styles.css` and replace the hand-mirrored `dashboard/src/types.ts` with a shared server type contract (F16).
4. Split `SummaryPlannerLoopRuntime.requestProviderAction` and add it to the regression guard (F17).
5. Bench/eval residual: relocate `eval.ts`/`benchmark-spec-settings.ts` in the server/workspace split; dedupe `bench/benchmark` vs `bench/benchmark-matrix` harness modules (F15).
6. LLM-behavior fixes (Part 2), highest leverage first: extend grammar-constrained decoding to the repo-search loop (L6); make all harness messages append-only and non-assistant-role (L4, L5, L7); fix the finish gate to match the prompt (L2); wire condense/compaction into what the model actually sees with pair-preserving selection (L5, L10); split sampling profiles by request class (L1).
