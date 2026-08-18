# Handoff: repo-agent hallucinated end signals — investigation, A/B experiments, OOM crash (2026-08-18)

Session investigated why repo-agent claims "done" when it isn't, or denies edits it made.
All findings below are transcript-verified (runtime DB `run_logs.repo_search_transcript_jsonl`).

## Root causes found (ranked by leverage)

### 1. No mutation/finish gate — the chronic enabler of every failure mode
- `evaluateFinishAttempt` (src/tool-loop-governor.ts:224-248) is a citation gate for repo-search Q&A,
  reused for repo-agent (loopKind resolves to 'repo-search' at src/repo-search/execute.ts:397). It
  auto-allows ANY finish whose output lacks `file:line` anchors, and never considers mutations.
- `repo-agent-sessions.ts:312-320` grants `completed` whenever the engine resolves; scorecard
  `passed`/`commandFailures`/`reason` are discarded. `formatRepoTaskOutput` (src/repo-agent/run-output.ts)
  appends harness-recorded "Files modified by this run:" ONLY when mutatedPaths is non-empty — a claim
  of created files with zero mutations stands uncontradicted.
- `mutatedPaths` only records native write/edit tools (tool-action-processor.ts:1052-1065). Edits made
  via `run` commands are invisible (repro'd: Set-Content via run → file created, output "No changes
  made." uncorrected). Harness never runs git status/diff.
- `buildFinishValidationPrompt` (src/repo-search/prompts.ts:332) is DEAD CODE — zero call sites.
- Smoking gun "wp2" (engine run 645152aa): model emitted a finish whose own output text said
  "I have not yet written the failing test… I should not finish; I need to continue… If this finish
  was issued by mistake, please let me continue." Harness settled it `completed`, `passed:true`.
  Mechanism: finish decision + summary are fused in one generation; grammar has no continue/cancel
  action; nothing parses finish text; no injection/forced-finish/budget event was involved (verified).

### 2. Thinking-budget splice (the Aug-17 regression trigger; now mostly dormant)
- Commit 8a8a2117 (Aug 17) added client-side reasoning-budget enforcement for exl3. On exhaustion,
  `continueAfterThinkingBudget` (src/llm-protocol/llama-cpp-client.ts:331-343) splices the preset
  message "Thinking budget exhausted. You have to provide the answer now." INTO the model's own closed
  think block → model reads it as its own conclusion → immediate premature/fabricated finish.
- Verified in the wild: run 8d9c02d4 turn 30 — thinking truncated mid-test-code, splice, then finish
  claiming "Task 1 complete" while abandoning Tasks 2-3 (right after clobbering a test file via write).
- Budget check compares a CHAR ESTIMATE (`estimateTokenCountFromCharacters`, ratio from
  `observed_budget_state.last_known_chars_per_token` = 3.01, learned from INPUT-side telemetry) against
  the budget. Thinking prose runs ~4.3 chars/token → fires ~30-40% early (splice hit at 7,033 real
  tokens on a 10k budget). llama-cpp-client.ts:487-489.
- Exl3 stream has NO per-frame usage (probed: usage only in final frame; frames are multi-token,
  MTP speculative). Fix options: self-calibrating thinking-side ratio (exact usage arrives each turn);
  or one exact countTokens call near the boundary; or server-side budget in the Tabby wrapper.
- Commit 1fd50167 (Aug 18, 09:10) replaced wording with PLANNER_REASONING_BUDGET_MESSAGE ("emit next
  tool action, do not finish") for non-chat loops when preset message == stock default (it is). Gaps:
  llama backend (server-side injection), customized preset messages. Delivery is still forged-thought.
- Currently dormant: preset ReasoningBudget=100000 unreachable within maxOutputTokens 15000.

### 3. Reviewer-policy bleed (A/B-tested; recommend removing from agent prompt)
- The approval-review policy (src/repo-search/approval-review-policy.ts, spliced into
  buildAgentSystemPrompt at src/repo-search/prompts.ts:288) is 512 tokens / 2,577 chars of imperative
  reviewer rules present in EVERY agent turn (system prompt 7,004 chars with, 4,425 without).
- Historical role collapse: run b9ae3dde (Aug 17) — after 15 normal turns, model hallucinated an
  <APPROVAL_REVIEW_REQUEST> for its own upcoming edit and finished by narrating the imaginary review.
  0 edits; settled `completed`. No actual approval message was injected (verified all turn_new_messages).
- A/B (byte-identical task: "Implement ONLY Task 1 from the plan at
  c:/tmp/rsx/2026-08-18-repo-search-batching-analysis.md…", model 3.8_27b_4.6bpw exl3):
  - WITH policy: morning 43373469 = total fabrication ("13/13 pass", nothing on disk, 0 write attempts,
    30 turns); attempt1 = honest premature finish t33; 150k wp1 = full success (47 turns); 150k wp2 =
    the self-protesting finish above. → 1/4 full success.
  - WITHOUT policy (temporarily removed from prompts.ts, rebuilt, verified 4,425-char sys prompt in
    transcripts): attempt3 = full success; 150k np1 = full success (40 turns, 6/6 tests verified);
    150k np2 = full success (48 turns, 13/13 verified). → 3/3 full success.
  - (attempt2 no-policy died to infra OOM, honest `failed` — excluded.)
- Verdict-request design: same model, same conversation prefix, ephemeral user message
  (requestApprovalVerdict, planner-protocol.ts:804; task-loop.ts:349 — "never appended to transcript",
  byte-prefix asserted for prompt cache). Moving the policy to verdict-only costs ~0.5s re-prefill per
  verdict at observed ~1200 T/s.

### 4. exl3 backend crash (attempt2 post-mortem)
- Primary: `torch.OutOfMemoryError` in exllamav3 reconstruct_hgemm during ~52.7k-token prefill at
  NumCtx=160000 (preallocated cache) — RTX 4090 24GB had only ~1.5GB free idle (model+cache+MTP+vision).
- Cascade: TabbyAPI "FATAL ERROR… recreate the generator" → recreated generator's recurrent/MTP state
  pool broken → every request 503 `AssertionError: Cannot create new state: no available slots` until
  process restart. Log source: `inference_run_log_chunks` (run 8e786073).
- Harness misclassified: empty aborted streams counted as model invalid responses (3 → invalid_response_limit),
  then terminal synthesis retried 3× against the dead backend. Should be infra-failure handling + managed
  backend restart.
- Empirical: at NumCtx=150000 (user-approved change, STILL IN EFFECT in app_config
  server_llama_presets_json, preset exl3-3-6-27b-2), 4 runs, zero OOM, backend served up to 93,975-token
  context, VRAM floor ~453 MiB. Still thin; SiftKit maxPromptBudget (~135k) far exceeds servable (~50-90k).

## Recommended fixes (user has NOT yet requested implementation)
1. Mutation-aware finish gate: reject finish on implementation runs with empty mutatedPaths (cross-check
   `git status --porcelain` for command-shaped edits); always emit "Files modified: (none)"; surface
   passed/commandFailures/reason in settled output; optionally wire the dead finish-validation prompt.
   Also: an un-finish/continue path (wp2 exhibit).
2. Budget splice: calibrated thinking-side token ratio or boundary-exact count; deliver exhaustion as an
   attributed harness message (not forged thought); llama-backend gap remains.
3. Remove/relocate reviewer policy from agent system prompt (A/B evidence above).
4. Infra: classify provider empty/503 as backend failure + auto-restart managed backend; consider Tabby
   watchdog for FATAL generation errors; align maxPromptBudget with servable context.

## Current system state (post-session)
- Repo tree: prompts.ts REVERTED to original (policy present), rebuilt via `npx tsc -p tsconfig.json` +
  `node --experimental-strip-types scripts/sync-dist-runtime.ts` (NOTE: bare tsc emits to dist/src/ —
  sync step is mandatory; bare tsc alone does NOT update what the server loads).
- Untracked in tree: tests/analyze-repo-search-batching.test.ts + scripts/analyze-repo-search-batching.ts
  (np2's verified implementation of the batching-analysis plan Task 1; 13/13 tests pass). Keep or delete.
- Status server: running as a background child of the Claude session (`node dist\status-server\main.js`,
  port 4765) — the user's original `npm start` supervisor lost its status child (vite dashboard on 6876
  still under old supervisor). Restart the supervisor when convenient.
- Preset NumCtx=150000 (changed from 160000 during OOM testing; left in place).
- Artifacts/scratch: c:\tmp\rsx\150k-runs\{wp1,np1,np2}\, c:\tmp\rsx\attempt3-artifacts\,
  c:\tmp\rsx\2026-08-18-repo-search-batching-analysis.md (plan file reconstructed from transcript after
  original was deleted; em-dashes repaired), c:\tmp\rsx\batching-analysis.json (CLI output),
  c:\tmp\rsx\*.cjs (debug query scripts against .siftkit/runtime.sqlite — safe to delete).
- Some experiment repo-agent run dirs remain under .siftkit/repo-agent/runs (terminal; retention prunes).

## Key evidence anchors (runtime DB, SiftKit repo .siftkit/runtime.sqlite)
- Fabricated run: run_logs request_id 43373469… ; self-protesting finish: 645152aa… ;
  reviewer collapse: b9ae3dde… ; splice run: 8d9c02d4… ; OOM backend log: inference_run_log_chunks
  run 8e786073… ; A/B 150k runs: 15021117 (wp1), 645152aa (wp2), a8edfc2c (np1), b325e0e6 (np2).
