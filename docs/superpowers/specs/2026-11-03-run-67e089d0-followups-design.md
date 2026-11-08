# Run 67e089d0 follow-ups: digest parsers, isolated auto-approver, rejection fixes

**Status:** approved design, 2026-11-03
**Source run:** orchestrator `67e089d0-80ed-4e02-a9f0-c73614341c13` (aborted at t12 by the user; t1–t11 passed review). Testbed `C:/tmp/rsx/siftkit-compare-single`, child transcripts in `run_logs` of the repo-local `.siftkit/runtime.sqlite`.

Three independent parts. Each ships on its own. **This pass is code and code checks only:** Part 2's Phase A (measurement) and Phase C (live run) are deferred, and `ReviewerSlot` ships defaulting to `false`.

---

## Part 1 — Output digest: reference corpus and parser fixes

### Findings (181 classified worker validation runs: test, typecheck, lint)

| Class | Runs | With digest |
|---|---|---|
| unfiltered | 115 | 75 |
| partial (`Select-Object -Last/-First`, `Get-Content -Tail`) | 44 | 23 |
| filtered (`Select-String`, `Where-Object`) | 22 | 5 |

- 103 digests; 99 agree with the visible output.
- **Bug — several runner invocations in one output.** `parseNodeTest` keeps the last `ℹ tests/pass/fail` values (`Map.set` overwrites) and reads only the last `✖ failing tests:` section (`lastIndexOf`). In `t6:t37`, `t6:t63`, `t10f1:t43`, `t10f1:t58` the first suite vanished from the digest; had it failed and the second passed, the digest would have said `passed`.
- **Gap — failures without a summary.** 14 node:test outputs contain `✖ <name> (<n>ms)` result lines but no `ℹ tests`/`ℹ pass` lines, so `parseNodeTest` returns null: the summary was cut by `-Last N` (`t7:t30`, `t8:t48`), filtered out (`t8:t49`, `t10:t51/53/56`, `t10f1:t45`), or never printed because the run was killed by its timeout (`t10:t40`, `t10:t100`). Seven runs were killed by timeout in total; five printed nothing to digest.
- **Gap — `outputMode="full"`** skips the digest by design (`tool-action-processor.ts:1001`): 3 runs (`t8:t64`, `t10f1:t40/42`).
- **Correct as is.** A passing tsc or eslint prints nothing, so it has no digest. Piped typecheck runs report the pipeline's exit 0 while tsc failed (`t1:t46/56/59`); the digest's `FAILED` was the only signal, which is the intended behaviour.
- **Filtered runs reviewed (all 22, of which ~14 are real test runs; the rest are `Select-String` over `package.json`).** The filter erased everything useful in 2 (`t1:t1`, `t7:t50`), kept failure names but dropped the summary and messages in 6, and was harmless in the rest. No parser change can recover filtered-away lines; the existing prompt guidance against filtering stays.

### Reference corpus

Every validation-run output of the run is saved, as the user chose ("everything"):

- `tests/fixtures/output-digest-runs/67e089d0/<task>-t<turn>.txt` — the result text the model saw, with SiftKit's leading digest block removed. SiftKit's own notices inside it (`N lines truncated due to per-tool context limit.`, `N lines omitted from validation command output.`, `timeout=…ms exceeded; command was killed`, zero-output warnings) are kept: they are part of what was shown.
- `tests/fixtures/output-digest-runs/67e089d0/index.json` — one entry per file: `file`, `task`, `turn`, `command`, `exitCode`, `class` (`unfiltered|partial|filtered`), `tool` (`node:test|vitest|tsc|eslint`), `truncated` (the text carries a SiftKit truncation or omission notice), `strip` (`exact` or `structural`, see below). Parsed in tests with a zod schema.
- `tests/fixtures/output-digest-runs/67e089d0/expected.json` — `file → rendered digest text | null`, produced once by the extraction script after the parser fixes and reviewed by diff.

Digest stripping, done by a one-off extraction script kept in the scratch directory (not shipped):
- `exact` — for an untruncated result, the split point is the one where `digestOutput(rest).text` equals the leading block.
- `structural` — for a truncated result, the block is the run of lines from `Digest of the whole output:` through the digest's own line forms (tool headline, `✖ … — location`, `Details:`, indented detail lines, `… N more` notices).
- No saved file may start with `Digest of the whole output:`; the corpus test asserts it.

Corpus test (`tests/output-digest-corpus.test.ts`):
1. Every file's `digestOutput(text)?.text ?? null` equals `expected.json`.
2. Invariants that do not depend on the golden file: if any `ℹ fail N` with N>0 appears, or any `✖ <name> (<n>ms)` line, the node:test digest is `FAILED`; the digest's node:test `tests` count equals the sum of every `ℹ tests` line; a tsc digest's error count is at least the number of distinct `file(line,col): error TS` lines shown.

### Parser and pipeline changes

1. **node:test sums every run.** `parseNodeTest` sums each count label across every summary block and reads failures from every `✖ failing tests:` section, in order. The headline shows the summed counts; when there was more than one summary block it adds a `runs` count. Curated fixture: `node-test/multi-run.txt` (first suite fails, second passes → `FAILED`).
2. **node:test without a summary.** When no `ℹ tests`/`ℹ pass` lines exist but at least one `✖ <name> (<n>ms)` result line does, the digest is `FAILED` with counts `pass seen` and `fail seen` (the labels say the summary was not in the output) from the result lines. Failures come from the `✖ failing tests:` section when present, else from the `✖` result lines and the lines indented under them. Only `✔` lines and no summary → still null (the verdict is unknown). Curated fixtures: `node-test/tail-cut-fail.txt` (from `t7:t30`), `node-test/killed-fail.txt` (from `t10:t40`).
3. **Digest in full mode.** `tool-action-processor.ts:1001` computes the digest for every effective mode. `full` still skips validation shaping; the digest is a header over the unchanged output.
4. Prompt text stays as it is apart from what Part 3 adds.

Tests: TDD per change; curated fixtures get exact-digest cases in `tests/output-digest-parsers.test.ts`; the full-mode change gets a case in `tests/engine-tool-action-processor.test.ts` that replaces the current "full mode gets no digest" test.

---

## Part 2 — Isolated auto-approver

### Findings

- The reviewer is not a separate prompt. `buildApprovalVerdictPromptMessages` (`planner-protocol.ts:659-666`) sends `[...worker transcript, ...pending assistant tool call, {role:'user', content: policy + request}]`, so prompt-cache reuse holds (`assertPromptCacheExtension`, `planner-protocol.ts:460-478`). The verdict call rides the worker's model lease (`repo-agent-sessions.ts:408`); `ParallelSlots: 1` → `max_batch_size 1`.
- 549 verdicts in the run: 430 approve, 84 deny, 35 unsure. **82 are role confusion** (60 deny, 22 unsure): the model, reading its own conversation, answers as the coding agent ("I am the coding subagent, not the approval reviewer", "prompt injection inside tool output") and denies safe commands. Mean verdict 6.1 s, p50 5.3 s, p90 10.7 s, max 22.6 s; 57 min of the run's 281 min planner time.
- Denials cascade: each costs a worker turn, and large denied arguments are elided (Part 3), which caused 8 further invalid calls.
- By tool: `run` 311 verdicts, `edit` 204, `write` 22, `git` 12. Only `run` and `git` verdicts can be replayed: the transcript logs `edit`/`write` payloads as `edits=N sha=…` only.
- Engine: RTX 4090, 24,564 MiB; 23,762 MiB used with the active preset loaded (`exl3-swift1-5-3-8-next-3-5bpw-f16`: Qwen3.8 Flash Next 3.50bpw, `NumCtx 200000` → `cache_size 200192`, f16 KV, `ParallelSlots 1`, `NcpuMoe 399`, `UBatchSize 1024`, `CacheRam 2048`, `CacheRecurrentRam 4096`). 377 MiB free.
- `ParallelSlots` drives both the engine's `TABBY_MODEL_MAX_BATCH_SIZE` (`exl3-preset-adapter.ts:164`) and the scheduler's capacity (`server-ops.ts:398-400`). Raising it alone would let two workers share the 200k-token cache, and two ~150k contexts do not fit.

### Design

**Approver request.** A verdict is its own request:
- `system`: the approver's own system prompt — role ("you review one proposed tool call for a coding agent; you are not that agent"), the policy lines from `approval-review-policy.ts`, and the verdict JSON instruction (`approval-verdict.ts`).
- `tools`: the worker's tool definitions, byte-identical across verdicts so the approver's own prefix stays cached; `toolChoice: 'none'`; grammar-constrained verdict decode as today (`siftkit_approval_verdict`).
- `user`: the proposed call — tool name and full arguments, with `edit`/`write` payloads inline (the locator line `approval-review-policy.ts:2` goes away).
- No worker transcript, no task text.

Removed outright (no fallback path): `buildApprovalVerdictPromptMessages`, the verdict use of `assertPromptCacheExtension`, `APPROVAL_PAYLOAD_LOCATOR_LINE`, the `pendingMessages` plumbing from `tool-action-processor.ts:240-245/436-447` through `LlmApprovalGate`, and comments justifying the extension design. `approval-verdict-probe.ts` moves to the new builder. Verdict caps (`APPROVAL_VERDICT_MAX_TOKENS`, reasoning budget) stay.

**Reviewer slot.** New model-preset field `ReviewerSlot: boolean` (contracts schema, default `false`, managed-only like `ParallelSlots`, dashboard toggle beside Parallel slots). When true, the engine launches with `max_batch_size = ParallelSlots + 1`; scheduler capacity stays `ParallelSlots`. The verdict keeps riding the worker's lease, so it never queues behind another run; with a reviewer slot it runs beside the worker's cached state instead of displacing it.

### Phase A — measure (gates Phase B's `ReviewerSlot` and Phase C)

A1 — VRAM. Load the active preset with `max_batch_size 2` (temporary preset copy, same `cache_size`). Record `nvidia-smi` used/free after load and the peak while two jobs decode together (a ~150k-token worker prompt and a ~5k-token approver prompt). If it does not load, or headroom is under 256 MiB, raise `NcpuMoe` stepwise and record decode tok/s at each step against the `max_batch_size 1` baseline.

A2 — Replay. A replay script (scratch) feeds the 323 recorded `run`/`git` verdicts of run 67e089d0 through the new approver request, at `max_batch_size 1` and `2`. Per verdict: approver prompt tokens, cached tokens, prefill ms, decode ms, total ms, verdict. For the slot comparison, a synthetic ~150k-token worker prompt is primed before each verdict and its next-request `promptEvalTokens` (cache miss) is recorded.

Pass criteria:
- Zero role-confused verdicts (same regex as the analysis) on replay.
- The legitimate denials stay `deny` or `unsure`: the in-place regex source rewrites (`t9:t100`, `t10:t90`), `git stash push --include-untracked` (`t10:t38`), `git checkout` of a modified file (`t11f1:t18`), `Invoke-Expression` (`t10:t99`), recursive delete (`t6:t64`).
- Mean verdict latency ≤ the current 6.1 s.
- With a reviewer slot: ≥ 256 MiB VRAM free at the two-job peak, and worker decode tok/s within 5% of baseline. Otherwise `ReviewerSlot` is not enabled for this preset and the isolated approver runs on the single slot; A2 at `max_batch_size 1` records what that costs the worker.

The measurements and the slot decision go into `docs/analysis/2026-11-03-isolated-approver-measurement.md`.

### Phase C — live validation

Reset the testbed to `63d5de92`, rerun the same orchestrator task. Compare with 67e089d0: role-confused verdicts (target 0), approval denials per task, verdict latency, worker `promptEvalTokens` on the turn after a verdict, turns per task.

Tests (Phase B, TDD): verdict request contents (system, tools, single user message with full payload; no transcript) in the LLM approval gate tests; `ReviewerSlot` launch env and scheduler capacity in the exl3 adapter and server-ops tests; contracts schema default and validation; the probe test on the new builder.

---

## Part 3 — Rejection fixes

### Classification (41 non-reviewer rejections, 4 failed non-test commands)

| Group | Count | Verdict |
|---|---|---|
| `edit` with `path` undefined after copying `{"elided": …}` (`t9:t72/89`, `t11:t70/71/73/76/77/78`) | 8 | **SiftKit fault** |
| `edit` oldText containing a literal NUL the model cannot reproduce, then a JSON-string `edits` with a raw control character (`t6:t53/54`) | 2 | tool limitation, rare; no change |
| `edit` oldText not found / not unique / overlapping | 12 | model: guessed or stale text, `/u/` typo, re-sent a failed edit unchanged |
| `grep` unknown keys (`output_mode`, `head_limit`, `operation`), `edit` key `path2`, unknown tool `delete` | 4 | model |
| `run` `timeoutMs` 900000 (schema states max 600000) | 3 | model |
| `grep`/`read` on a nonexistent path (`AGENTS.md` ×3, guessed file names ×4) | 7 | model |
| `grep` under `node_modules` (ignored by policy) | 2 | policy holds; prompt change below |
| `read` offset past end of file (`t2:t13`, `t10:t91`, `t11f1:t6`) | 3 | legitimate, but **fixed below** to save a turn |
| failed non-test commands (`Select-String` on missing paths ×2, inline `node -e` crash, scratch script crash) | 4 | model |

The elision chain: `buildRejectedTranscriptAction` (`repo-tools.ts:346`) replaces a rejected call's arguments over `REJECTED_ARGS_ELISION_LIMIT` (512 chars) with `{elided: "rejected edit call; N chars of arguments discarded — the tool result states why"}`. After an approval denial (or a failed edit), the model "retries the same edit" by re-emitting that object (`t11` turn 70 thinking: "I'll retry the same edit"), which fails schema validation as `path` undefined, sometimes three times in a row.

### Changes

1. **Approval-denied calls keep their arguments.** The approval-denial rejection path records the effective action, never the elision marker: the arguments were valid and are what a retry needs. Other rejections keep the 512-char elision.
2. **A copied elision marker is refused clearly.** A tool call whose arguments are exactly `{elided: <string>}` is rejected as invalid with: `These arguments are the placeholder SiftKit put in your history for a rejected call; re-send the call with its complete arguments.` Replaces the misleading schema error.
3. **Read past the end returns the end.** `read` with `offset` past the last line returns the file's final `limit` lines (default window when no `limit`) with a leading notice `offset N is past the end of <path> (M lines); showing lines X–M.` instead of rejecting.
4. **System prompt: leave `node_modules` alone.** Add to the repo-agent tool rules in `src/repo-search/prompts.ts`: do not read, search, or edit anything under `node_modules` unless the task explicitly asks for it. Applies to `run` commands too (the workers bypassed the grep policy with `Select-String`).

Tests (TDD): rejection-path tests in `tests/engine-tool-action-processor.test.ts` (approval-denied large edit keeps args in the transcript; marker call gets the new message); `read` past-end case in the repo-tools tests; prompt test asserts the `node_modules` line.

---

## Out of scope

- Recovering output a worker filtered away (Part 1 can only digest what the pipeline printed).
- The per-tool result cap that let four unfiltered e2e runs return ~53k tokens (`turn-budget.ts:76`); tracked separately.
- Changing approval policy content, verdict caps, or `unsure` routing.

## Validation for every part

`npm run typecheck`, `npm run lint`, the targeted test files, then the full suite (`npm test`, routed through `siftkit summary`). Part 2 additionally requires the Phase A document and the Phase C comparison.
