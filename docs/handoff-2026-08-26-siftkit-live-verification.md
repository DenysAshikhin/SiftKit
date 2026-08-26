# Handoff: post-merge live verification, two bug fixes, draft-window benchmark (2026-08-26, PM)

Follows `docs/handoff-2026-08-26-tabby-merge.md` (morning session). Everything below is
**uncommitted** — review, then commit. The SiftKit status server was left **running** on
127.0.0.1:4765 (rebuilt dist, healthy, model loaded) with the preset back at its
original settings.

## 1. TabbyAPI: merge left a startup crash on MTP drafting — fixed (uncommitted)

First live launch after the morning merge died at model load:

```
backends/exllamav3/model.py:271
draft_model_path = draft_model_path / self.draft_model_name
TypeError: unsupported operand type(s) for /: 'WindowsPath' and 'NoneType'
```

Root cause: the merge resolution kept two `self.`-qualified leftovers from our
pre-merge fork code inside upstream's rewritten draft-config block (`self.draft_mode`
at 264, `self.draft_model_name` at 271) while upstream uses the locals parsed from
kwargs. Stale class defaults (`draft_mode = "model"`, `draft_model_name = None`)
masked it from unit tests; with our MTP preset (`draft_mode=mtp`, no draft model
name) it took the separate-draft-model branch and crashed. **Every SiftKit exl3
launch was broken.**

Fix (3 lines, net −2, block now logic-identical to upstream — fork delta shrank):
`self.draft_mode` → `draft_mode`, `self.draft_model_name` → `draft_model_name`,
deleted the two stale class attributes so a future missed migration fails loudly.
TDD: `tests/test_exl3_draft_mtp_config.py` (new) reproduces the exact TypeError via
mocked `create()`, red before / green after. Tabby suite: **169/169**, compileall clean.

## 2. SiftKit: repo-agent chronic failure root-caused and fixed (uncommitted)

`siftkit repo-agent` had been failing with `invalid_response_limit` in 4 of its last
6 runs (including two on Aug 25 — pre-merge, so NOT caused by the merge or the
Formatron-lowerer removal). Transcript evidence: the model's `edit` tool call arrived
with `edits` as a *JSON-stringified array* ("expected array, received string" from zod).

Root cause chain:
- SiftKit sends `tools` natively; Tabby never grammar-constrains tool calls (neither
  pre- nor post-merge) and, with no `tool_format` configured, returns the raw
  `<function=...><parameter=...>` text.
- SiftKit's fallback parser `src/llm-protocol/tool-call-parser.ts:149`
  (`parseQwenParameterValue`) coerces bools/numbers/null but **not arrays/objects** —
  every structured parameter became a string.

Fix at the schema-aware layer (the parser has no type context; blind `JSON.parse`
there would corrupt string params that merely look like JSON — Tabby's own
`coerce_param_value` has that flaw): `src/planner-protocol/native-actions.ts` now
retries validation after parsing a string value **only** where the schema expects an
array/object at that exact path, bounded to 4 repairs. Mirrors the existing
double-encoding repair in `ModelJson.parseToolArgumentsText`. TDD: 4 new tests in
`tests/native-planner-actions.test.ts` (repair array, repair nested object, non-JSON
string still fails, JSON-looking string params untouched).

Verified live post-rebuild: a fresh repo-agent dispatch performed a multi-line doc
edit correctly on the first attempt.

## 3. Live CLI verification (all four surfaces, real model)

- **chat** (dashboard sessions API): ✓, response carried
  `speculativeAcceptedTokens: 44 / speculativeGeneratedTokens: 68`.
- **summary** (piped input): ✓, accurate.
- **repo-search**: ✓, returned exact `file:line` anchors.
- **repo-agent**: ✓ after §2 (see quirks below).
- MTP drafting confirmed enabled and active: startup log "Using main model MTP
  component for drafting"; live acceptance 49–90% depending on workload/sampling.

Repo-agent harness quirks for whoever touches it next (not fixed, by scope):
- The scorecard marks a run `failed` if any auxiliary command failed, even when every
  acceptance criterion passed and the agent's edit landed. Exit code 1 + JSON
  `status: "failed"` therefore does not always mean the work is wrong — check the diff.
- The agent's `run` shell rejects `&&` chains (PowerShell 5.1); agents recover but eat
  a scorecard strike.
- The agent's `read` tool cannot read files outside the repo root — keep plan files
  in-repo (it recovered via `type`, at the cost of another strike).

## 4. SpeculativeDraftMax 3 vs 4: keep 4 (preset unchanged)

Three experiments, model `3.8_27b_4.4bpw`, `dynamic_draft` on, direct Tabby requests,
decode T/s + acceptance from Tabby metrics log:

1. **Greedy** (temp 0, fixed prompt, 3 runs each): 4 → ~104 T/s (95.7–114.5);
   3 → ~90 T/s (82.7–96.0). Clear ~15% win for 4.
2. **Preset sampling** (temp 1.0 / top_p 0.95 / top_k 20, thinking on, same prompt,
   4 runs each): 4 → ~84.1; 3 → ~81.8. Within noise.
3. **Preset sampling, 5 distinct coding prompts** (implement/debug/refactor/review/
   tests, one run each): 4 → ~92.6 mean; 3 → ~91.2 mean; per-prompt winner simply
   tracked whichever run got higher acceptance.

Reading: under sampling, acceptance variance (49–67%) dominates; the cap only matters
in high-acceptance regimes, where 4 wins. `SpeculativeDraftMax: 4` confirmed and
restored (flip was done by editing `server_llama_presets_json` in
`.siftkit/runtime.sqlite` with the server stopped, then relaunching).

## 5. Upstream-flag audit (merge window)

- **`vision_offload` — the one worth adopting; NEXT SESSION'S TASK, see §7.**
- `cpu_moe_split_experts` / `cpu_moe_threads` / `cpu_moe_offload_layers`: N/A —
  `3.8_27b` has no MoE config.
- ngram drafting (`draft_mode: ngram`): not needed, MTP measured better.
- Native reasoning budget (upstream f1f2c85): SiftKit already enforces budgets
  client-side (`llama-cpp-client.ts` budget stop + continuation); possible future
  simplification only. Note upstream disables budget injection when constrained
  generation is active.
- Harmony / MuseGlimmer / Deepseek-V4 / Laguna tool parsers, logit_bias, XTC: N/A.

## 6. Validation snapshot + uncommitted state

- SiftKit: **3320 pass / 0 fail / 1 pre-existing skip**; `npm run typecheck`
  (chains lint) exit 0; `npm run build` done (server runs the rebuilt dist).
- TabbyAPI: **169/169**, compileall clean, plus heavy live traffic.
- Uncommitted — SiftKit: `src/planner-protocol/native-actions.ts`,
  `tests/native-planner-actions.test.ts`,
  `docs/handoff-2026-08-26-tabby-merge.md` (161/161→167/167 count fix + the
  `vision_offload` Open-items bullet, the latter written by the repo-agent live test),
  and this file. TabbyAPI (`siftkit` branch): `backends/exllamav3/model.py` (+2/−4),
  `tests/test_exl3_draft_mtp_config.py` (new). Suggested: one commit per repo; push
  Tabby to `fork`, never `origin`.

## 7. Next task: adopt `vision_offload` in SiftKit, verify end-to-end

Goal: both exl3 presets run vision-capable models (`VisionEnabled: true`), so the
vision tower sits in VRAM while repo-search/repo-agent traffic is text-only.
`vision_offload` pins vision weights in system RAM instead.

Mechanics on the Tabby side (already merged, no Tabby changes expected):
- Config field `vision_offload` in the `model` section → env
  `TABBY_MODEL_VISION_OFFLOAD` (Tabby derives `TABBY_{section}_{field}`; verify
  against `common/config_models.py` before wiring, same pattern
  `test_exl3_env_overrides.py` guards).
- `backends/exllamav3/model.py:216` sets `config.infer_params.vision_pinned` from it;
  success log line: "Keeping vision model weights in system RAM (vision_offload)."
  (model.py:221). It must be set **before** the vision component loads.

SiftKit wiring (mirror the 75ebe867 env-rename commit's shape):
- Preset field (config normalization + defaults + dashboard
  `settings-sections.ts` help text), `Exl3LaunchEnvironmentSchema` + emission in
  `src/inference-presets/exl3-preset-adapter.ts`, tests first in
  `tests/model-preset-adapters.test.ts` / `tests/managed-tabby.test.ts`.

"Genuinely works end-to-end" checklist:
1. Launch env contains `TABBY_MODEL_VISION_OFFLOAD=true`; Tabby log shows the
   "Keeping vision model weights in system RAM" line.
2. VRAM delta: compare `nvidia-smi` (or Tabby's loader output) with the flag on vs
   off — the tower should move out of dedicated VRAM (note: pinned host RAM counts
   as shared GPU memory on Windows, same caveat as the sysmem KV cache).
3. A vision request still works (dashboard chat image caption path) — latency hit is
   expected and acceptable.
4. Interaction with the fork's freeze/restore (`freeze_to_ram`/`restore_from_freeze`
   + `vision_model` handling in `test_exl3_freeze_residency.py`): freeze/unfreeze a
   vision-pinned model and confirm no double-pinning or restore regression.
5. Text-only traffic unaffected: rerun a repo-search smoke and compare decode T/s
   (~95–140 T/s at accept-dependent variance is the current normal).

## Scratch

`c:\tmp\rsx` was used for throwaway scripts; all session artifacts there were deleted.
