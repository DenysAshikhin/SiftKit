# SiftKit Architecture Review

## Purpose of this file

This document is a point-in-time audit of the SiftKit repository, intended as a working reference for prioritizing refactors and fixes. It records:

1. **Part 1 (F2–F18, with gaps where findings were resolved and deleted)** — architectural issues, code smells, and repo semantics that make the codebase harder to scale, extend, or maintain (duplication, dead code, god-functions, untyped boundaries, build/test hazards, packaging problems), plus a purpose-level assessment of whether the project is doing anything fundamentally wrong, a suggested module partition, and a priority-ordered fix list.
2. **Part 2 (L1–L11)** — an LLM-behavior analysis of the runtime surfaces that talk to the model (managed llama-server config, repo-search agentic loop, multi-turn chat, conversation-context handling), flagging divergences from established LLM-integration norms that raise the chance of the model misbehaving or failing to work as intended. Each finding includes explicit "why it's an issue" reasoning.

Every claim is backed by `file:line` evidence verified against the working tree on the audit date. This file is descriptive, not a change plan — no code was modified as part of the audit. Findings should be re-verified against current code before acting on them, as line numbers and behavior drift.

Date: 2026-06-09. Scope: full repo scan for architectural issues, smells, and purpose-level assessment. Findings appended as discovered.

Updated 2026-06-10: resolved findings (F1 `runTaskLoop` god-function, F5 shadow `.d.ts`, F8 require-cache engine loading, F9 stale committed `src/**/*.js`, F12 split-brain execution) were verified fixed and deleted from this document — finding numbers therefore have gaps. Remaining findings re-verified and anchors refreshed.

## Repo purpose (as stated)

Windows-first toolkit that compresses noisy shell output / repo exploration for AI coding agents using a local `llama.cpp` model. Two processes: TS CLI client + long-running status/config server (owns config, runs DB, llama.cpp lifecycle, dashboard).

---

## Findings

### F2. Root-directory litter

Working tree top level contains scratch artifacts (`tmp-confirm-web-context.ts`, `siftkit-0.1.0.tgz`) — gitignored, so cosmetic only. Tracked: `initialTurnChatIssues.md` (a session-notes dump) and `run.bat` at root; both belong under `docs/` or nowhere. Packaging note: package.json `files` ships `scripts` and `eval` (dev/benchmark harnesses) to npm consumers.

### F3. Server side is effectively untyped: `Dict = Record<string, unknown>` is the dominant type

`src/lib/types.ts` defines `export type Dict = Record<string, unknown>` — used **306 times across 30 files**, concentrated in the status server (`config-store.ts` 44, `chat.ts` 44, `dashboard-runs.ts` 36, routes 53+). Core domain objects — the config, chat sessions/messages, presets, run records — flow through the server as `Dict`, with dozens of hand-rolled coercers (`getTrimmedString`, `getOptionalNumber`, `getPositiveNumber`, `getFiniteInteger`, `getNonNegativeNumber` — several re-implemented per file). This directly contradicts the project's own standard ("everything typed, avoid unknown/generics/any") and is the root cause of much accidental complexity: every consumer re-validates the same shapes. The client side has typed config (`src/config/types.ts`); the server never shares it.

### F4. Developer-machine paths hardcoded as shipped defaults

`src/status-server/config-store.ts:14-15`:
```ts
export const DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const DEFAULT_LLAMA_EXECUTABLE_PATH = 'C:\\Users\\denys\\Documents\\GitHub\\llamacpp\\llama-server.exe';
```
Absolute paths from one developer's machine are compiled into the product as defaults. For a toolkit whose stated purpose is general Windows distribution, this is a fundamental wrong: defaults must be empty/discovered, with fail-loud validation — which the project philosophy already endorses.

### F6. Test architecture: split-brain between `dist` and `src`, and near-zero typechecking of tests

- Test files import **~94 paths from `../dist/...` and ~80 from `../src/...`** — the same suite simultaneously tests compiled output and raw TS. A test passing can mean "current source works" or "whatever was last built works", depending on the file. `build-test.js` mitigates with an mtime stamp, but the mixed convention makes every test's subject ambiguous and blocks coverage tooling from a single view (the `test:coverage` script only includes `dist/**`).
- `tsconfig.test.json` includes `src/**/*.ts` plus only **17 of ~140 test files** (the engine/chat suites added during the repo-search loop decomposition). `npm run typecheck:test` still skips ~88% of the test suite; type errors in those tests surface only at tsx runtime, or never (tsx does not typecheck).

### F7. Hand-rolled HTTP layer with god-route-handlers

The server is raw `node:http` with four sequential mega-handlers (`routes.ts` tries dashboard → chat → llama-passthrough → core). Inside each, a single exported function string-matches `pathname`(24 branch sites) and inlines the endpoint logic: `handleChatRoute` is ~980 lines (`routes/chat.ts:395-1373`), `handleCoreRoute` ~800 lines (`routes/core.ts:624-1424`), `routes/dashboard.ts` has 16 pathname branches in 577 lines. There is no route table, no per-endpoint module, no shared request-body validation. Adding an endpoint means editing a giant function; the README's "server contract" lives nowhere in code as a checkable surface.

### F10. Config is defined three-and-a-half times, and the copies have already diverged

1. **Client typed defaults** — `src/config/defaults.ts:getDefaultConfigObject(): SiftConfig` (+ `src/config/constants.ts` `SIFT_DEFAULT_LLAMA_*`).
2. **Server untyped defaults** — `src/status-server/config-store.ts:getDefaultConfig(): Dict` (+ its own `DEFAULT_LLAMA_*` constants with the same values copied).
3. **Dashboard hand-mirrored types** — `dashboard/src/types.ts` (573 lines) redeclares config/preset/session payload shapes from scratch (plus a stale 456-line `types.d.ts` copy).
4. (half) **`src/llama-cpp-bridge.ts`** builds yet another inline `SiftConfig` literal with its own hardcoded thresholds.

Proven drift between (1) and (2): client default preset has `ModelPath: null, ExecutablePath: null`; server default uses the hardcoded developer paths (F4). Every config change requires touching 3+ files (the repo's own plan docs in `docs/superpowers/plans/*` repeatedly list `defaults.ts` **and** `config-store.ts` as parallel edit sites — institutionalized duplication). One typed schema module shared by client, server, and dashboard would eliminate the entire class.

### F11. Dead code and "legacy" constants that violate the project's no-legacy rule

- `getDefaultConfigObject` (`src/config/defaults.ts`) has **zero importers** in `src/`, `tests/`, or `scripts/` — the typed default config is dead; the live one is the untyped server `Dict` version.
- `src/llama-cpp-bridge.ts` (107 lines) is referenced by nothing but a docs inventory file.
- `src/config/constants.ts` exports `SIFT_LEGACY_DEFAULT_NUM_CTX`, `SIFT_LEGACY_DERIVED_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_NUM_CTX`, `SIFT_PREVIOUS_DEFAULT_MODEL`, `SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS` — named legacy-compat values still re-exported through `src/config/index.ts`, against the stated "no legacy compatibility" rule.
- `SIFTKIT_VERSION = '0.1.0'` in `constants.ts` duplicates `package.json` `version` by hand.
- `tsconfig.json` includes `test-full.ts`, which does not exist.
- `src/execution-lock.ts` and `src/config/execution-lease.ts` existed largely to coordinate the now-removed client/server split-brain execution; with the server as sole engine owner they are intra-process-only serialization and candidates for deletion (still imported by `summary/core.ts`, `eval.ts`, `install.ts`).

### F13. Three-plus parallel agentic-loop / LLM-protocol implementations

OpenAI-style chat/tool-call protocol handling is implemented independently in:

- `src/repo-search/planner-protocol.ts` (989 lines: streaming, tool-call parsing, retry, runaway detection, repetition guards) feeding the repo-search engine loop (`src/repo-search/engine/task-loop.ts`);
- `src/summary/planner/` (`mode.ts` 793 + `tools.ts` 438 + `json-filter.ts` + `provider.ts`) — a second planner loop with its own tool definitions and invalid-action handling;
- `src/providers/llama-cpp.ts` (655 lines) — a third request/parse layer (`generateLlamaCppChatResponse`, structured-output parsing);
- plus fragments in `src/status-server/chat.ts` (replay tool-call reconstruction), `src/tool-call-messages.ts`, `src/lib/model-json.ts`.

`tool_calls` parsing alone appears in ~10 modules. Each loop re-implements: token budgeting, thinking-buffer handling, repetition detection, retry policy, transcript building. A single `AgentLoop` + `LlamaCppClient` abstraction (which the repo's DRY/class rules already demand) would collapse thousands of lines. The docs plan `2026-06-05-unify-chat-agentic-loop.md` shows this is a known debt — partially executed at best.

### F14. Test architecture is inverted and self-undermining

- The dominant harness is `tests/_runtime-helpers.ts` — 1,573 lines, opening with `// @ts-nocheck — Full typing deferred. Auto-generated from runtime.test.js infrastructure block`. The shared infrastructure for ~30 runtime test files is untyped and was machine-translated from JS, in a repo whose rules require strict typing and near-100% branch coverage.
- Mixed `dist`/`src` imports (F6) make every test's subject ambiguous.
- Giant end-to-end tests dominate (2,142-line `dashboard-status-server.test.ts`, 2,009-line `repo-search-loop.core.test.ts`, tests that boot the real HTTP server + sqlite). The repo-search loop decomposition added unit seams there; the F7 route god-functions still force integration-test cost elsewhere.
- Test seams ship inside production modules: `src/summary/mock.ts` (`SIFTKIT_TEST_PROVIDER_BEHAVIOR`, `SIFTKIT_TEST_TOKEN`), and mock command results (`findMockResult`, `src/repo-search/engine/command-execution.ts`) live in the production execution path.

### F15. Benchmark/eval harnesses live inside the product

`src/benchmark/`, `src/benchmark-matrix/`, `src/benchmark-spec-settings.ts`, `src/eval.ts`, plus repro scripts (`scripts/repro-fixture60-malformed-json.ts`, `run-benchmark-fixture-debug.ts`) are part of the shipping module graph — `tests/_runtime-helpers.ts` even imports repro scripts from `dist/scripts/`. `benchmark/` and `benchmark-matrix/` duplicate each other's args/interrupt/runner/types modules (`args.ts`, `interrupt.ts`, `runner.ts`, `types.ts` exist in both with parallel roles). The npm `files` array ships `eval` (untracked locally, 32MB / 2,248 files on this machine — whatever happens to be there gets packed) and `scripts`. Dev harnesses should be out of `src/` and out of the package.

### F16. Dashboard monolith and styling sprawl

`dashboard/src/App.tsx` is 1,337 lines; `styles.css` 1,486 lines alongside a parallel `styles/` directory; type mirroring per F10. The dashboard has its own `node_modules`/build but no shared contract with the server it talks to — every API change is a manual two-sided edit verified only by integration tests.

### F17. God-function inventory

| Function | File | Approx. lines |
|---|---|---|
| `handleChatRoute` | `src/status-server/routes/chat.ts:395` | ~980 |
| `handleCoreRoute` | `src/status-server/routes/core.ts:624` | ~800 |
| `invokePlannerMode` | `src/summary/planner/mode.ts:123` | ~670 |
| `summarizeRequest` + `invokeSummaryCore` | `src/summary/core.ts` | ~380 each |
| `requestPlannerAction`/`requestStreaming` | `src/repo-search/planner-protocol.ts` | ~180/~200 |
| `dashboard-runs.ts` (module) | `src/status-server/` | 1,731 |

The repo rule "abstract into re-usable classes" is inverted in practice: the codebase is ~98% free functions, with the largest ones owning a dozen responsibilities each.

### F18. Helper re-implementation epidemic

Small coercion/parsing helpers are redefined per file rather than shared: `getPositiveNumber` (routes/core.ts, routes/chat.ts), `getOptionalNumber` (routes/core.ts, llama-cpp-bridge.ts), `getTrimmedString`/`getNullableTrimmedString`/`getFiniteInteger`/`getFiniteNumber`/`getNonNegativeNumber` variants across config-store, chat, metrics, status-file. Each is a symptom of F3 (untyped `Dict` boundaries force re-validation everywhere). Repeated awkward casts like `Parameters<typeof summarizeRequest>[0]['policyProfile']` (6+ sites) substitute for exporting the actual type.

---

## Purpose-level review: is the repo doing anything fundamentally wrong?

**The core idea is sound and differentiated**: a deterministic raw-first policy + cheap local model to compress agent-facing output, with raw logs always preserved. The conservative policy (short stays raw, error-dense stays raw-first) is the right product instinct, and the two-process split (CLI + supervising server) is a defensible shape for owning a llama.cpp lifecycle.

Fundamental concerns, in order of severity:

1. **The hard server dependency contradicts the product's job.** A token-compression CLI that *fails closed* when a local daemon is down means the tool is unavailable exactly when an agent mid-task needs it — and the agent then falls back to dumping raw output anyway, silently losing the entire value proposition. There is no degraded mode ("pass through raw + warn"). For a tool whose purpose is to *reduce* friction in agent loops, "no server → command fails" is a fundamental design wrong; fail-open-to-raw would preserve both auditability and usefulness. Since the CLI became a thin HTTP client (2026-06-10), every command requires the server, making this strictly more load-bearing.

2. **Scope has outgrown the stated purpose.** The README sells `summary` + `repo-search`. The codebase additionally contains: a chat product with sessions/replay/grounding policies, a web-search subsystem with multi-provider quota management, a React dashboard with preset editors and metric graphs, four benchmark harnesses, and an eval framework — all in one package, one version, one build. The "sift" core (policy + chunking + summarize) is well under 20% of the code. Nothing is wrong with any feature individually, but as one unpartitioned unit, every change rebuilds and retests everything, and the npm package ships dev harnesses. A workspace split (core / server / dashboard / bench-eval) is the natural partition.

3. **Single-developer assumptions are baked into shipped behavior** (F4): hardcoded `D:\personal\models\...` and `C:\Users\denys\...` defaults, `UNLICENSED`, version string duplicated by hand. Fine for a personal tool; wrong the moment the README's framing ("toolkit for Codex/Claude Code users") is taken seriously.

4. **The repo systematically violates its own stated engineering rules** (CLAUDE.md: strict typing, DRY, no legacy, classes, TDD): 306 `Dict` usages, `@ts-nocheck` core test harness, duplicated config/loops/helpers, `SIFT_LEGACY_*` constants, dead modules. The rules are right; the enforcement is absent. A lint gate (`no-restricted-syntax` for `Dict` in new code, max-function-length, import-boundary rules) would stop the bleeding.

## Suggested partition (mental model for future work)

- **core/** — policy, chunking, summary decision, prompt building, token measurement (pure, no I/O).
- **llm/** — single llama.cpp client + single agent-loop engine + tool-call protocol (one implementation, used by summary-planner, repo-search, chat).
- **server/** — HTTP surface (route table), config store (typed, single schema), runtime DB, managed-llama supervision, quotas.
- **cli/** — thin argument parsing + HTTP calls to server; local-only commands (`find-files`) stay self-contained.
- **dashboard/** — UI consuming a shared generated/imported type contract from server/.
- **bench-eval/** — benchmarks, eval, repro scripts; not shipped, not imported by src or tests-of-src.

---

# Part 2 — LLM-behavior analysis

Scope: managed llama-server config, the repo-search agentic loop, multi-turn chat, and conversation-context handling — specifically divergences from established LLM-integration norms that raise the chance of the model doing something silly or failing to work as intended.

## L1. Managed llama-server configuration issues

`buildManagedLlamaArgs` (`src/status-server/managed-llama.ts:652`) launches `llama-server` with one fixed profile: `--temp 0.7 --top-p 0.8 --top-k 20 --min-p 0 --presence-penalty 1.5 --repeat-penalty 1.0`.

**(a) One global sampling profile for all request types.**
- Why it's an issue: SiftKit serves at least four distinct workloads through this one server — strict-JSON planner actions, structured-output extraction, finish-validation verdicts, and free-prose synthesis/chat. These have opposite sampling needs: JSON/tool-call decoding wants near-greedy determinism (temp ≤0.3) so the action parser sees the same shape every turn; prose wants the creative profile. One profile means at least one class is always mis-sampled.
- Why it's an issue: a temp-0.7/top-p-0.8 planner is *nondeterministically* wrong — the same repo-search question can produce a clean run today and an invalid-action retry spiral tomorrow, which makes loop failures unreproducible and the benchmark numbers noisy.

**(b) `--presence-penalty 1.5` applied to JSON-emitting loops.**
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

- That rejection message exists nowhere; `minToolCallsBeforeFinish` is computed and logged (`src/repo-search/engine/task-loop.ts:126,424`) but never enforced.
- The actual gate, `evaluateFinishAttempt` (`src/tool-loop-governor.ts:195`), **allows** a finish with *zero* evidence-bearing tool calls or no `file:line` anchors (`if (!outputHasAnchors || supportedCalls.length === 0) return { allowed: true }`), **rejects** exactly the case of an anchored answer backed by one evidence-bearing call, and its final "no evidence" rejection branch is unreachable dead code.

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

Two mechanisms rewrite already-sent messages inside the repo-search loop (and the same pattern exists in the summary planner, `src/summary/planner/mode.ts:512-526`):

- On repeated duplicates, the *previous* tool-result message is overwritten with "duplicate command requested xN" (`src/repo-search/engine/transcript-manager.ts:77-78`, driven by `tool-action-processor.ts`) — earlier evidence the model saw is replaced.
- Forced-finish countdowns upsert a trailing user message in place (`upsertTrailingUserMessage`, `src/repo-search/engine/transcript-manager.ts:86`).

Why it's an issue (norm is append-only transcripts):
- Editing an early message invalidates the llama.cpp prompt-cache prefix from that point on, forcing re-evaluation of up to ~100k tokens of context on every subsequent turn — on local hardware this is the difference between sub-second and tens-of-seconds prompt processing, and it defeats `cache_prompt` entirely.
- The model's own earlier replies now reference evidence that no longer exists in the transcript. Its rational recovery move is to re-run the vanished command — which is a duplicate, which is punished, which deepens the spiral. Alternatively it distrusts the transcript and restates the evidence from memory, i.e. fabricates.

## L5. Context compaction can produce protocol-invalid transcripts

`compactPlannerMessagesOnce` (`src/repo-search/prompt-budget.ts:200`) selects messages to keep purely by greedy token-fit (system + last user + newest-first whatever fits). There is no constraint keeping an `assistant.tool_calls` message and its `role:"tool"` response together.

Why it's an issue:
- Compaction can emit a `tool` message whose `tool_call_id` has no preceding assistant tool call — invalid under the OpenAI chat schema. llama.cpp jinja chat templates either throw (the request fails exactly when the loop is deepest into a task) or silently misrender, leaving tool output attributed to nobody; the model then misattributes or ignores evidence it actually gathered.
- The "[COMPRESSED HISTORICAL EVIDENCE]" digest is injected as an **assistant** message — fabricated assistant speech. The model sees itself having "said" a harness notice, which both normalizes emitting meta-text in its own replies and lets finish-validation read the digest as model-claimed evidence. Norm: system/user role for harness notices.
- The greedy fit re-renders and re-tokenizes the whole transcript over HTTP for every candidate message (O(n) tokenize calls, 10s timeout each). Compaction runs precisely when the context is fullest, so the worst-case latency lands at the most latency-sensitive moment of a run.

## L6. Dual action protocol with permissive parsing

The system prompt orders "Return ONE valid JSON object — no markdown fences" (JSON-in-content protocol) while the same request registers native tool definitions; the parser then accepts native `tool_calls`, raw JSON in content, the first balanced `{…}` found anywhere in prose, and `jsonrepair`'d fragments (`planner-protocol.ts:657-710`).

Why it's an issue:
- The two protocols conflict at the template level: with native tool definitions registered, the chat template formats the conversation the way the model was *trained* to emit `tool_calls`; instructing it to instead write raw JSON into `content` fights that training distribution and raises malformed-output rates on its own.
- Every format variant the parser tolerates becomes few-shot precedent in the transcript. A model that drifted once (prose-wrapped JSON, repaired fragment) sees its drift accepted and replayed, so drift compounds across turns instead of self-correcting.
- Silent repair hides the failure signal: metrics count the turn as a successful action, so systematic prompt/sampling problems (see L1b) never surface — nothing forces a root-cause fix.
- Norm: one protocol per loop — native tool-calling exclusively, or grammar-constrained decoding (llama.cpp grammar / `response_format`) that makes invalid actions unrepresentable instead of repairing them post-hoc.

## L7. Harness narration is written into the assistant's own messages

When stream guards fire, the recorded assistant message becomes `"SiftKit stopped the planner stream early: <reason>.\n<truncated content>"` (`buildEarlyStoppedPlannerText`, `planner-protocol.ts:740`). That text is replayed on subsequent turns as something the assistant said.

Why it's an issue:
- The model is conditioned on its "own" prior output containing third-person narration about itself; mimicking its own transcript is exactly what next-token prediction does, so later turns start emitting similar meta-text into answers.
- Finish-validation and terminal-synthesis prompts feed the transcript back as evidence — harness artifacts get weighed as if the model asserted them, skewing pass/fail verdicts and the salvage answer.
- Norm: harness interventions go in `system`/`user` messages or out-of-band metadata, never inside assistant content.

## L8. Default chat system prompt is a five-word fragment

`DEFAULT_CHAT_SYSTEM_PROMPT = 'general, coder friendly assistant'` (`src/status-server/chat.ts:18`). Not a sentence, no behavioral contract, no tool guidance, no output expectations.

Why it's an issue:
- Small quantized local models are the population most dependent on explicit system-prompt steering; with a five-word fragment, output format, verbosity, tool-usage judgment, and refusal behavior are all left to sampling noise — the same question produces materially different behavior session to session, which users read as flakiness.
- The fragment isn't even grammatical instruction ("general, coder friendly assistant" is a noun phrase); weak/ambiguous system text measurably reduces instruction-following on whatever *is* appended after it (e.g. the web-grounding instruction block from L11 inherits a degraded frame).
- The contrast with repo-search (60 lines of hard constraints) means switching surface/preset swings the model between over- and under-constrained regimes; both extremes diverge from the norm of concise but complete role + capability + format instructions.

## L9. Cross-turn tool replay invents a tool that doesn't exist

`buildChatHistoryMessages` replays prior turns' tool activity as assistant `tool_calls` against a synthesized function named `persisted_tool_call` with `{"command": …}` arguments (`chat.ts:251`) — a tool name never present in the offered tool set for the current turn.

Why it's an issue:
- The context shows successful precedent for calling a tool that isn't declared this turn. Tool-name selection in small models is heavily primed by in-context examples, so this directly raises hallucinated-tool-call rates — and when the model does call `persisted_tool_call`, the parser rejects it as invalid, feeding the invalid-response ladder.
- Replayed outputs silently substitute `toolCallOutputSnippet` (a truncated UI snippet) for the full output. The model believes it already holds complete evidence and answers from an ellipsized fragment instead of re-fetching — confident wrong answers grounded in text that was cut mid-result.
- Norm: replay with the same tool names/schemas offered this turn, or compress prior tool activity into clearly-labeled user/system context.

## L10. Chat "condense" is a no-op for the model — and the context meter is char-estimated in both directions

- `condenseChatSession` (`chat.ts:~530`) marks older messages `compressedIntoSummary: true` and stores a `condensedSummary`. **No prompt builder reads either field**: `buildChatHistoryMessages` iterates all `session.messages` with no `compressedIntoSummary` filter, and `condensedSummary` is never injected into any prompt (verified by repo-wide search — it is only persisted/reset).
  - Why it's an issue: pressing "condense" changes nothing the model sees — the full history still replays, so the overflow behavior the user tried to fix persists, now behind UI state claiming it was handled. Debugging "why is the model still confused after condensing" is unwinnable because the feature is cosmetic.
- The "summary" itself, were it ever used, is not a summary: it is the **last 2,400 characters** of a `role: content` dump (tool outputs excluded), typically starting mid-sentence.
  - Why it's an issue: if this is ever wired in, the model's entire memory of the conversation becomes a ~1k-token arbitrary tail with no tool evidence — earlier commitments, constraints, and facts vanish without the model being told, so it contradicts its own prior answers. Ironic given that LLM summarization is the product's core competency.
- Context accounting: `ContextUsageBuilder` (`chat.ts:82-145`) now follows the configured `NumCtx` (both default 150,000), but usage is still char-estimated where recorded token counts are missing, and per-message estimates include thinking tokens that are *never replayed* (history drops `assistant_thinking`); `shouldCondense` triggers at 10% remaining of that estimate.
  - Why it's an issue: a char-based estimate can show green while the real rendered prompt already exceeds the server's window. llama.cpp then truncates or rejects: truncation typically eats the *front* of the prompt — the system prompt and earliest instructions — so the model silently loses its persona/format contract and "goes silly" in ways nothing in the UI explains.
  - Why it's an issue: counting never-replayed thinking tokens inflates usage in the other direction, so condense warnings can also fire far too early — the meter is wrong in both directions, making its one job (triggering condensation at the right time) unreliable.

## L11. Web grounding policy forbids answering from memory — for every message in a web-enabled session

`CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION` mandates "Run web_search before answering. Web-enabled chat is not allowed to answer from memory alone", and finish is rejected up to 3 times until grounded.

Why it's an issue:
- The trigger is a session flag, not claim type: "thanks, reformat that as a table" in a web-enabled session forces a web search the answer doesn't need — wasted latency and quota (the providers are metered), plus irrelevant search results entering context where they can contaminate the actual reformatting task.
- The forced search collides with the duplicate-query rejection: a conversational turn has no natural query, so the model improvises one close to a previous search, gets rejected, retries, and can burn all 3 finish rejections on a message that needed zero evidence — surfacing to the user as the model refusing or stalling on a trivial request.
- The anti-hallucination intent is right; norm is conditioning grounding requirements on whether the answer makes factual claims.

## Summary of Part 2

The recurring pattern: the harness distrusts the model and intervenes aggressively (count-based finish gates, duplicate punishment, in-place history rewrites, stream truncation, format repair), but several interventions are themselves out-of-norm (assistant-role injection, fictitious replay tools, mutated transcripts, inverted gate logic, dead condense path) and actively create the confusion they defend against. The highest-leverage fixes: enforce one action protocol with grammar-constrained decoding (L6), make all harness messages append-only and non-assistant-role (L4, L5, L7), fix the finish gate to match the prompt (L2), wire condense/compaction into what the model actually sees with pair-preserving selection (L5, L10), and split sampling profiles by request class (L1).

## Priority order (highest leverage first)

1. Single typed config schema shared by client/server/dashboard; kill `Dict` at the boundaries (F3, F10).
2. Unify the agentic loop + llama.cpp protocol layer (F13).
3. Break up the remaining god-functions (F17) — prerequisite for any unit-test pyramid recovery (F14).
4. Repackage: move bench/eval out of `src` and out of npm `files`; fix `files` array (F15, F2).
5. Replace machine-specific defaults with fail-loud unset values (F4).
6. Route table + per-endpoint handlers in the server (F7).
