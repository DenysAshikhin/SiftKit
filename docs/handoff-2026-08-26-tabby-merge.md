# Handoff: Tabby upstream merge, env rename, grammar benchmark, Formatron removal (2026-08-26)

Everything below is committed and pushed. TabbyAPI work is on `siftkit` @ `92cbf9f`
(pushed to `fork`, i.e. DenysAshikhin/tabbyAPI — `origin` is upstream theroyallab and
was not touched). SiftKit work is on `main` through `849511b8` (pushed to origin).

## 1. TabbyAPI: merged upstream main (`92cbf9f`)

Merged `origin/main` tip `fcc1a10` into `siftkit` per
`docs/superpowers/plans/2026-08-26-tabby-upstream-merge-and-env-rename.md`.
Four conflicts, all resolved to the pre-agreed outcomes:

- **`grammar.py`** — took upstream's LLGuidance rewrite wholesale. Our Formatron
  filter cache (`04f32a4`) and its `model.py` wiring were dropped, not ported.
  Why: upstream replaced the grammar engine; the cache only existed to amortize
  Formatron's ~410 ms schema compiles (see §3 — LLGuidance doesn't need it).
- **`model.py`** — kept upstream's inline draft-config block and names; deleted our
  `configure_drafting` extraction (upstream's block is semantically identical) and
  both `schema_filter_cache.clear()` sites (in `unload()` and `freeze_to_ram()` —
  the plan quoted one older form; the try/except pairs were the current shape).
  Our `freeze_to_ram`/`restore_from_freeze` survived untouched.
- **Feature renames** — adopted upstream's `dynamic_draft` (was `draft_dynamic`)
  and `sysmem_kv_cache` (was `sysmem_page_cache`). Why: both features were
  upstreamed under new names; keeping ours would fork the config surface forever.
- **`pyproject.toml`** — kept the fork pin, bumped to `exllamav3 == 1.4.4+unified.1`
  (both cu12/cu13). Why: freeze/restore requires `Model.freeze`/`FrozenTensorSource`
  from the local unified tree; upstream wheels lack it, so the pin fails loudly on
  reinstall instead of silently dropping freeze support. Installed env already had
  `1.4.4+unified.1`; no reinstall was needed.
- **Tests** — deleted `test_grammar_filter_cache.py` and
  `test_exl3_draft_dynamic_and_page_cache.py` (they tested dropped code); added
  `test_exl3_env_overrides.py` guarding the env-string → typed-config contract for
  the two renamed vars, since SiftKit launches Tabby purely via `TABBY_*` overrides.

Verified: 167/167 unit tests, `compileall` clean, grammar import smoke test OK,
whole-repo grep shows zero references to any dropped name.

Remaining custom surface vs upstream (10 files, +1387/−89): freeze/restore residency
(model.py, common/model.py, core/router.py + 2 test files), usage-stats detail
counters (`prompt_tokens_details.cached_tokens`,
`completion_tokens_details.accepted/rejected_prediction_tokens` + test), the fork
pin, and the env-contract test.

## 2. SiftKit: env-var rename (`75ebe867`)

Tabby derives env names as `TABBY_{section}_{field}`, so the renames above changed
the launch contract. The old vars are now **silently ignored** by Tabby — this
commit is mandatory alongside the merge:

- `TABBY_MEMORY_SYSMEM_PAGE_CACHE` → `TABBY_MEMORY_SYSMEM_KV_CACHE`
- `TABBY_DRAFT_MODEL_DRAFT_DYNAMIC` → `TABBY_DRAFT_MODEL_DYNAMIC_DRAFT`

Changed: `src/inference-presets/exl3-preset-adapter.ts` (schema + emission),
`tests/managed-tabby.test.ts`, `tests/model-preset-adapters.test.ts` (missed by the
plan, caught by the straggler grep), `dashboard/src/settings-sections.ts` help text.
TDD: test updated first, failed on exactly the two keys, then adapter updated.

## 3. A/B benchmark: pp/decode + grammar cache impact

Full results in `docs/tabby-llguidance-benchmark-2026-08-26.md`. Merged `92cbf9f`
vs pre-merge `907c954`, model `3.8_27b_4.4bpw` on the 4090, same exllamav3 wheel.

- **Unconstrained pp/decode: parity.** ~2.1k t/s prefill (13.3k-token prompt),
  ~50.2 t/s decode on both builds. Expected — grammar code never runs without
  `json_schema`.
- **Grammar TTFT: cache question closed.** Uncached LLGuidance compiles a
  never-seen schema in ~0–15 ms vs Formatron's ~410 ms per cache miss, and matches
  Formatron's *cached* path (~0.09 s) on repeats. First-ever constrained request
  (one-time engine init) also improved: 1.70 s vs 2.32 s.
- **Bonus: constrained decode ~50% faster** on a complex nested schema
  (40–51 t/s vs 26–34 t/s) — LLGuidance's per-token masking is cheaper.

**Decision: no LLGuidance-side filter cache will be built.** The deferred gate from
the merge plan is closed.

## 4. SiftKit: FormatronSchemaLowerer removed (`849511b8`)

`src/providers/formatron-schema-lowering.ts` force-required all properties and
null-wrapped optionals — a workaround for Formatron's missing optional-property
support. LLGuidance handles optionals natively (live-verified during the benchmark:
the complex schema had a non-required property) and §3 shows no perf reason to
pre-lower. Removed outright per repo refactor rules (no compat path):

- Deleted the lowerer + `tests/formatron-schema-lowering.test.ts`.
- `inference-request-builder.ts` now passes `response_format` through unchanged.
- Rewrote the EXL3 builder test to assert passthrough (TDD: red before removal).
- Also removed two dead artifacts: `tests/fixtures/formatron-planner-schema.py`
  (drove Formatron internals that no longer exist) and the `test:formatron` npm
  script (its target test file no longer existed).

**Client-visible change (intended):** structured-output responses may now omit
optional fields instead of emitting `"field": null`. Nothing in-repo relied on the
null-wrapping (full suite green), but external consumers of SiftKit structured
output should be aware.

## 5. Housekeeping

- TabbyAPI stash (stale 1.4.2→1.4.3 pin edit, superseded by the merge) dropped.
- Merge plan + benchmark docs committed (`66ced409`).
- Old `config.yml` keys `draft_dynamic:`/`sysmem_page_cache:` are silently dead in
  Tabby now; SiftKit is migrated, nothing else known to use them.

## Validation snapshot

- TabbyAPI: 167/167 tests, compileall clean, live server exercised heavily by §3.
- SiftKit: 3316 pass / 0 fail / 1 pre-existing skip; `npm run typecheck` (chains
  lint) exit 0. `timing-recorder.test.ts` flaked once under full-suite load,
  passed 4/4 in isolation and the full-suite rerun — unrelated, timing-based.

## Open items

None from this work. Notes for whoever is next:

- The SiftKit status server (127.0.0.1:4765) was down for this whole session, so
  `siftkit repo-agent`/`repo-search` were unavailable and work fell back to direct
  implementation.
- The exllamav3 pin comment in `pyproject.toml` still points at the editable
  install in `D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench`; keep
  `+unified.N` in sync with `exllamav3/version.py` there when that tree moves.
- Upstream now exposes `vision_offload` (pins vision-tower weights in system RAM). Both
  exl3 presets run vision-capable models with `VisionEnabled: true`, so the tower sits in
  VRAM while repo-search/repo-agent traffic is text-only. Candidate flag to adopt in the
  EXL3 preset adapter if VRAM pressure appears.
