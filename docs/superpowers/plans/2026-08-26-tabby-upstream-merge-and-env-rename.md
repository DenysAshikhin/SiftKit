# TabbyAPI Upstream Merge + SiftKit Env Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `origin/main` (theroyallab/tabbyAPI, tip `fcc1a10`) into the `siftkit` branch, adopting upstream's LLGuidance grammar backend and its `dynamic_draft`/`sysmem_kv_cache` names in place of our duplicates, then rename the matching `TABBY_*` launch env vars in SiftKit so the two land together.

**Architecture:** One merge commit in `C:\Users\denys\Documents\GitHub\TabbyAPI` resolving 4 conflicted files with pre-agreed outcomes (upstream wins everywhere except the exllamav3 fork pin), plus deletion of two obsolete test files and one replacement env-contract test. Then a small rename change in SiftKit (`exl3-preset-adapter.ts`, its test, dashboard help text). The grammar filter cache (`04f32a4`) is dropped, not ported — benchmark later before deciding on a rewrite.

**Tech Stack:** git merge, Python 3.13 (`C:\envs\rl313-turbo\Scripts\python.exe`, has exllamav3 `1.4.4+unified.1` with `LLGuidanceFilter` + `llguidance` installed), TypeScript/Node (SiftKit).

**Agreed resolutions (from conversation):**

| Item | Resolution |
|---|---|
| `grammar.py` | Take upstream (LLGuidance) wholesale; drop our Formatron filter cache + its wiring |
| `draft_dynamic` → `dynamic_draft` | Adopt upstream name everywhere |
| `sysmem_page_cache` → `sysmem_kv_cache` | Adopt upstream name everywhere |
| `configure_drafting` | Delete; take upstream's inline block verbatim (upstream already contains both validations) |
| `pyproject.toml` | Keep fork pin, bump to `exllamav3 == 1.4.4+unified.1` (both cu12 and cu13) |
| Keep unchanged | freeze/restore endpoints (`fadff69`), usage-stats details (`9a5e047`+`f552eac`) |
| Filter cache perf | Deferred: benchmark structured output on merged build before any LLGuidance cache rewrite |

**Known facts (verified, do not re-derive):**
- Merge base is `0158fb48`. `git merge-tree` shows exactly 4 content conflicts: `backends/exllamav3/grammar.py`, `backends/exllamav3/model.py`, `common/config_models.py`, `pyproject.toml`. `common/model.py` and `endpoints/OAI/utils/common_.py` auto-merge cleanly and are semantically safe.
- Upstream removed `formatron`/`kbnf` deps (merges clean) and added `numpy`.
- Upstream requires `check_package_version("exllamav3", "1.4.4")`; installed metadata is `1.4.4+unified.1` → passes, no reinstall needed.
- Tabby env var naming is `TABBY_{section}_{field}`.upper() (`common/tabby_config.py:159`), so the new vars are `TABBY_DRAFT_MODEL_DYNAMIC_DRAFT` and `TABBY_MEMORY_SYSMEM_KV_CACHE`.
- `Dict`/`Any` remain used in model.py (lines ~104, 704, 1195, 1263) after deleting `configure_drafting` — leave typing imports alone.
- TabbyAPI working tree has ONE dirty file: `pyproject.toml` (stale uncommitted 1.4.2→1.4.3 pin bump, superseded by this merge).
- **Pre-merge baselines (verified 2026-08-26):** Tabby suite = 156 tests OK in ~3s (explicit-module form; `tests/` has NO `__init__.py`, so `unittest discover` fails — never use it). SiftKit `managed-tabby` filter = 14 tests OK.
- `merge.conflictstyle` is unset (default markers) — the conflict blocks quoted in Task 4 match what `git merge` will produce verbatim.
- `tests/req_grammar.py` was rewritten by upstream `a99d928` and we never touched it → the merge auto-updates it to the LLGuidance version (verified: merged blob == upstream blob). No action needed.
- SiftKit's MTP-drafting startup-log marker (`'Using main model MTP component for drafting'`, `src/status-server/tabby-run-recorder.ts:4`) is unchanged in upstream and present in the merged tree — that contract survives the merge.
- The local untracked `TabbyAPI/config.yml` contains neither `draft_dynamic` nor `sysmem_page_cache` — no silent config loss there.

---

### Task 1: Tabby preflight — stash the stale pin edit

**Files:**
- Modify (stash): `C:\Users\denys\Documents\GitHub\TabbyAPI\pyproject.toml`

All git commands below run with `git -C C:\Users\denys\Documents\GitHub\TabbyAPI` (or `cd` there once in Git Bash).

- [ ] **Step 1: Confirm expected dirty state**

Run: `git status --porcelain`
Expected: exactly ` M pyproject.toml`. If anything else is dirty, STOP and report.

- [ ] **Step 2: Stash the stale edit (recoverable, not discarded)**

```bash
git stash push -m "stale 1.4.2->1.4.3 exl3 pin bump; superseded by merge pin 1.4.4+unified.1" -- pyproject.toml
```

- [ ] **Step 3: Verify clean tree and correct branch**

Run: `git status --porcelain` → empty. `git branch --show-current` → `siftkit`.

### Task 2: Start the merge

- [ ] **Step 1: Merge (expect conflicts — this is not a failure)**

```bash
git merge origin/main
```

Expected: exit code 1 with exactly these four lines among the output:

```
CONFLICT (content): Merge conflict in backends/exllamav3/grammar.py
CONFLICT (content): Merge conflict in backends/exllamav3/model.py
CONFLICT (content): Merge conflict in common/config_models.py
CONFLICT (content): Merge conflict in pyproject.toml
```

If any OTHER file conflicts, STOP and report.

### Task 3: Resolve grammar.py and config_models.py — take upstream wholesale

Our only change to `common/config_models.py` was `6218098` (the two renamed fields being dropped), and grammar.py is being replaced by upstream's LLGuidance version, so `--theirs` is a complete resolution for both files.

- [ ] **Step 1: Take upstream versions**

```bash
git checkout --theirs backends/exllamav3/grammar.py common/config_models.py
git add backends/exllamav3/grammar.py common/config_models.py
```

- [ ] **Step 2: Verify contents**

```bash
grep -c "formatron\|FormatronFilter\|schema_filter_cache" backends/exllamav3/grammar.py   # expect 0
grep -n "LLGuidanceFilter" backends/exllamav3/grammar.py                                   # expect matches
grep -n "dynamic_draft\|sysmem_kv_cache" common/config_models.py                           # expect both fields
grep -c "draft_dynamic\|sysmem_page_cache" common/config_models.py                         # expect 0
```

### Task 4: Resolve model.py manually

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\TabbyAPI\backends\exllamav3\model.py`

Cannot use `--theirs` (would delete our clean-merged `freeze_to_ram`/`restore_from_freeze`). Resolve the three conflict hunks to upstream's side, then strip our two leftovers that merged clean (`configure_drafting`, filter-cache wiring).

- [ ] **Step 1: Resolve field-declaration hunk (~line 137)**

Replace:

```
<<<<<<< HEAD
    draft_dynamic: bool = False
=======
    dynamic_draft: Optional[bool] = False
>>>>>>> origin/main
```

with:

```python
    dynamic_draft: Optional[bool] = False
```

- [ ] **Step 2: Resolve draft-config hunk (~line 274)**

Replace the whole conflict block (from `<<<<<<< HEAD` through `>>>>>>> origin/main`) — whose HEAD side is the single line `        self.configure_drafting(draft_args)` — with the upstream side verbatim:

```python
        draft_mode = unwrap(draft_args.get("draft_mode"), "model")
        if draft_mode not in {"model", "disabled", "mtp", "ngram"}:
            raise ValueError(f"Unknown exllamav3 draft mode: {draft_mode}")
        draft_model_name = draft_args.get("draft_model_name")
        self.use_draft_model = draft_mode == "mtp" or (
            draft_mode == "model" and bool(draft_model_name)
        )
        self.ngram_match_min = (
            unwrap(draft_args.get("ngram_match_min"), 2) if draft_mode == "ngram" else 0
        )
        if draft_mode == "ngram" and self.ngram_match_min <= 0:
            raise ValueError("ngram_match_min must be greater than 0 for n-gram drafting")
        self.draft_num_tokens = (
            draft_args.get("draft_num_tokens")
            if self.use_draft_model or self.ngram_match_min
            else None
        )
        self.dynamic_draft = draft_args.get("dynamic_draft", False)

        # Always disable draft if params are incorrectly configured
        if draft_mode == "model" and draft_args and draft_model_name is None:
            xlogger.warning(
                "Draft model is disabled because a model name "
                "wasn't provided. Please check your config.yml!"
            )
```

- [ ] **Step 3: Resolve generator-kwargs hunk (~line 841) — the duplicate-kwarg trap**

The clean context line `cpu_cache_size=config.memory.sysmem_kv_cache * 1024**2,` already sits just above this conflict (upstream's). Replace:

```
<<<<<<< HEAD
                dynamic_draft_tokens=self.draft_dynamic,
                cpu_cache_size=unwrap(config.memory.sysmem_page_cache, 0) * 1024**2,
=======
                dynamic_draft_tokens=self.dynamic_draft,
>>>>>>> origin/main
```

with:

```python
                dynamic_draft_tokens=self.dynamic_draft,
```

- [ ] **Step 4: Revert the filter-cache import (line ~25)**

Replace:

```python
from backends.exllamav3.grammar import ExLlamaV3Grammar, schema_filter_cache
```

with:

```python
from backends.exllamav3.grammar import ExLlamaV3Grammar
```

- [ ] **Step 5: Delete the filter-cache clear in `unload()`**

Delete these two lines (just above `self.model.unload()`):

```python
            # Grammar automata are compiled against this model's vocabulary
            schema_filter_cache.clear()
```

- [ ] **Step 6: Delete the entire `configure_drafting` method**

Delete this whole block (sits just before the `# Required methods` comment / `@classmethod async def create`):

```python
    def configure_drafting(self, draft_args: Dict[str, Any]):
        """
        Resolves every drafting knob from the draft_model config section. Pure with respect to
        model and device state, so it is exercisable without loading a model.
        """

        self.draft_mode = unwrap(draft_args.get("draft_mode"), "model")
        if self.draft_mode not in {"model", "disabled", "mtp", "ngram"}:
            raise ValueError(f"Unknown exllamav3 draft mode: {self.draft_mode}")
        self.draft_model_name = draft_args.get("draft_model_name")
        self.use_draft_model = self.draft_mode == "mtp" or (
            self.draft_mode == "model" and bool(self.draft_model_name)
        )
        self.ngram_match_min = (
            unwrap(draft_args.get("ngram_match_min"), 2) if self.draft_mode == "ngram" else 0
        )
        if self.draft_mode == "ngram" and self.ngram_match_min <= 0:
            raise ValueError("ngram_match_min must be greater than 0 for n-gram drafting")
        self.draft_num_tokens = (
            draft_args.get("draft_num_tokens")
            if self.use_draft_model or self.ngram_match_min
            else None
        )
        self.draft_dynamic = (
            unwrap(draft_args.get("draft_dynamic"), False) if self.use_draft_model else False
        )

        # Always disable draft if params are incorrectly configured
        if self.draft_mode == "model" and draft_args and self.draft_model_name is None:
            xlogger.warning(
                "Draft model is disabled because a model name "
                "wasn't provided. Please check your config.yml!"
            )
```

- [ ] **Step 7: Verify and stage**

```bash
grep -c "<<<<<<<\|>>>>>>>\|configure_drafting\|draft_dynamic\|sysmem_page_cache\|schema_filter_cache" backends/exllamav3/model.py   # expect 0
grep -n "def freeze_to_ram\|def restore_from_freeze" backends/exllamav3/model.py   # expect both present
C:/envs/rl313-turbo/Scripts/python.exe -m py_compile backends/exllamav3/model.py   # expect silent success
git add backends/exllamav3/model.py
```

### Task 5: Resolve pyproject.toml — fork pin at 1.4.4

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\TabbyAPI\pyproject.toml`

Two identical conflict hunks (`cu12` and `cu13` extras): our pinned-fork comment block vs upstream's plain 1.4.4 wheel URLs. Keep ours, bump the version. Upstream's `formatron`/`kbnf` removal and `numpy` addition are outside the hunks and already merged.

- [ ] **Step 1: Resolve BOTH hunks the same way**

In each of the two conflict blocks, keep the HEAD side and delete the upstream side (all the `exllamav3 @ https://github.com/turboderp-org/...whl` lines), then bump the pin. Final content of each resolved block:

```toml
    # Exl3 - pinned to the unified local tree (siftkit freeze support merged with the
    # qbench/racefix dev branch). Editable-installed from
    # D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench; keep this pin in sync
    # with exllamav3/version.py there. Upstream wheels do not provide freeze support
    # (Model.freeze / FrozenTensorSource), so a reinstall fails loudly instead of
    # silently removing it.
    "exllamav3 == 1.4.4+unified.1",
```

- [ ] **Step 2: Verify and stage**

```bash
grep -c "<<<<<<<\|>>>>>>>" pyproject.toml            # expect 0
grep -c "1.4.4+unified.1" pyproject.toml              # expect 2
grep -c "formatron\|kbnf" pyproject.toml              # expect 0
grep -c "turboderp-org/exllamav3/releases" pyproject.toml  # expect 0
grep -n "numpy" pyproject.toml                        # expect present (upstream added it)
git add pyproject.toml
```

### Task 6: Replace obsolete tests

**Files:**
- Delete: `C:\Users\denys\Documents\GitHub\TabbyAPI\tests\test_grammar_filter_cache.py`
- Delete: `C:\Users\denys\Documents\GitHub\TabbyAPI\tests\test_exl3_draft_dynamic_and_page_cache.py`
- Create: `C:\Users\denys\Documents\GitHub\TabbyAPI\tests\test_exl3_env_overrides.py`

The deleted files test dropped code (Formatron cache, `configure_drafting`, old field names). The replacement pins the one contract that still matters: SiftKit launches Tabby purely via `TABBY_*` env overrides, so env string → typed config field must keep working under the NEW names.

- [ ] **Step 1: Delete obsolete tests**

```bash
git rm tests/test_grammar_filter_cache.py tests/test_exl3_draft_dynamic_and_page_cache.py
```

- [ ] **Step 2: Write the replacement test**

Full content of `tests/test_exl3_env_overrides.py`:

```python
import os
import unittest

from common.config_models import TabbyConfigModel
from common.tabby_config import TabbyConfig


class Exl3EnvOverrideTests(unittest.TestCase):
    """
    SiftKit launches TabbyAPI purely through TABBY_* environment overrides, so the contract that
    matters is: env string -> typed config field. Guards the upstream names adopted in the
    2026-08-26 merge (dynamic_draft, sysmem_kv_cache); a future upstream rename must fail here
    instead of silently ignoring the env vars.
    """

    ENV_KEYS = ("TABBY_DRAFT_MODEL_DYNAMIC_DRAFT", "TABBY_MEMORY_SYSMEM_KV_CACHE")

    def setUp(self):
        self.env_backup = {key: os.environ.get(key) for key in self.ENV_KEYS}

    def tearDown(self):
        for key, value in self.env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_environment_overrides_coerce_to_typed_config_fields(self):
        os.environ["TABBY_DRAFT_MODEL_DYNAMIC_DRAFT"] = "true"
        os.environ["TABBY_MEMORY_SYSMEM_KV_CACHE"] = "4096"

        config = TabbyConfigModel.model_validate(TabbyConfig()._from_environment())

        self.assertIs(config.draft_model.dynamic_draft, True)
        self.assertEqual(config.memory.sysmem_kv_cache, 4096)

    def test_defaults_leave_both_features_off(self):
        for key in self.ENV_KEYS:
            os.environ.pop(key, None)

        config = TabbyConfigModel.model_validate(TabbyConfig()._from_environment())

        self.assertIs(config.draft_model.dynamic_draft, False)
        self.assertEqual(config.memory.sysmem_kv_cache, 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run it**

Run: `C:/envs/rl313-turbo/Scripts/python.exe -m unittest tests.test_exl3_env_overrides -v` (cwd = TabbyAPI repo root)
Expected: 2 tests PASS. (It validates already-merged upstream code, so it passes immediately; its job is regression-guarding the env contract.)

- [ ] **Step 4: Stage**

```bash
git add tests/test_exl3_env_overrides.py
```

### Task 7: Whole-repo verification (still in merge, nothing committed yet)

- [ ] **Step 1: No leftover references anywhere in tracked code**

```bash
git grep -n "draft_dynamic\|sysmem_page_cache\|configure_drafting\|schema_filter_cache\|FormatronFilter\|add_kbnf_filter\|formatron" -- ':!*.md'
```

Expected: no output — upstream rewrote `tests/req_grammar.py` for LLGuidance, so even `kbnf`/`formatron` mentions there are gone. If this grep matches anything, inspect before proceeding.

- [ ] **Step 2: Everything compiles**

```bash
C:/envs/rl313-turbo/Scripts/python.exe -m compileall -q backends common endpoints
```

Expected: exit 0, no output.

- [ ] **Step 3: Grammar import smoke test**

```bash
C:/envs/rl313-turbo/Scripts/python.exe -c "from backends.exllamav3.grammar import ExLlamaV3Grammar; g = ExLlamaV3Grammar(); print('grammar ok', g.filters)"
```

Expected: `grammar ok []`

- [ ] **Step 4: Run the Tabby unit-test suite (explicit module list — `discover` does NOT work, `tests/` has no `__init__.py`)**

Run (cwd = TabbyAPI repo root):

```bash
C:/envs/rl313-turbo/Scripts/python.exe -m unittest \
  tests.test_context_length_errors tests.test_continue_final_message \
  tests.test_exl3_env_overrides tests.test_exl3_freeze_residency \
  tests.test_loop_detect_window tests.test_model_freeze_endpoints \
  tests.test_stream_parser tests.test_template_vars \
  tests.test_token_encode_endpoint tests.test_usage_stats
```

Expected: all pass (pre-merge baseline was 156 tests OK across the old module set; the count will shift slightly after removing two files and adding one). Pay attention to `test_usage_stats`, `test_model_freeze_endpoints`, `test_exl3_freeze_residency`, `test_stream_parser` (upstream changed Harmony parsing — a failure here means upstream behavior changed under a base-era test; investigate, do not paper over). The `req_*.py` files are live-server scripts, intentionally not run.

### Task 8: Commit the merge

- [ ] **Step 1: Confirm everything is staged**

Run: `git status --porcelain` — every line must be staged (no ` M`/`??` entries; `tests/test_exl3_env_overrides.py` staged as `A`).

- [ ] **Step 2: Commit**

```bash
git commit -m "Merge upstream main (fcc1a10): LLGuidance grammar, vision_offload, upstream feature names

Resolutions:
- grammar.py: take upstream LLGuidance rewrite; drop the Formatron filter
  cache (04f32a4) and its model.py wiring. Benchmark structured output
  before deciding whether an LLGuidance-side cache is needed.
- Adopt upstream names: draft_dynamic -> dynamic_draft,
  sysmem_page_cache -> sysmem_kv_cache. configure_drafting extraction
  dropped in favor of upstream's identical inline block.
- pyproject: keep the unified fork pin, bumped to 1.4.4+unified.1
  (freeze support requires the fork; formatron/kbnf deps removed upstream).
- Kept: freeze/restore endpoints, usage-stats token details.
- tests: replaced draft_dynamic/page_cache plumbing test with
  test_exl3_env_overrides.py guarding the new TABBY_* env names."
```

- [ ] **Step 3: Verify**

Run: `git log --oneline -2` (merge commit on top), `git status --porcelain` (empty).

### Task 9: SiftKit env-var renames (TDD: test first)

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\SiftKit\tests\managed-tabby.test.ts:179,184`
- Modify: `C:\Users\denys\Documents\GitHub\SiftKit\src\inference-presets\exl3-preset-adapter.ts:29-30,38,97,102`
- Modify: `C:\Users\denys\Documents\GitHub\SiftKit\dashboard\src\settings-sections.ts:137`

Rename map (Tabby derives env names as `TABBY_{section}_{field}`):
- `TABBY_MEMORY_SYSMEM_PAGE_CACHE` → `TABBY_MEMORY_SYSMEM_KV_CACHE`
- `TABBY_DRAFT_MODEL_DRAFT_DYNAMIC` → `TABBY_DRAFT_MODEL_DYNAMIC_DRAFT`

- [ ] **Step 1: Update the test expectation first**

In `tests/managed-tabby.test.ts` (the exact-env `assert.deepEqual` block), change:

```typescript
        TABBY_MEMORY_SYSMEM_PAGE_CACHE: String(fixture.exl3Preset.CacheRam),
```
to
```typescript
        TABBY_MEMORY_SYSMEM_KV_CACHE: String(fixture.exl3Preset.CacheRam),
```
and
```typescript
        TABBY_DRAFT_MODEL_DRAFT_DYNAMIC: 'true',
```
to
```typescript
        TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: 'true',
```

- [ ] **Step 2: Run the test — must FAIL (old names still emitted)**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js managed-tabby
```

Expected: FAIL on the deepEqual with the two renamed keys mismatched.

- [ ] **Step 3: Update the adapter**

In `src/inference-presets/exl3-preset-adapter.ts`, schema (lines 29-30 and 38):

```typescript
  /** MB of pinned host RAM for exllamav3's second-tier K/V cache; '0' disables. */
  TABBY_MEMORY_SYSMEM_KV_CACHE: z.string(),
```
and
```typescript
  /** Per-job draft windows adapted from the acceptance EMA, capped by DRAFT_NUM_TOKENS. */
  TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: z.enum(['true', 'false']),
```

In `buildLaunchEnvironment` (lines 97 and 102):

```typescript
      TABBY_MEMORY_SYSMEM_KV_CACHE: String(preset.CacheRam),
```
and
```typescript
      TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: preset.SpeculativeEnabled && preset.SpeculativeDynamic ? 'true' : 'false',
```

- [ ] **Step 4: Update dashboard help text**

In `dashboard/src/settings-sections.ts:137`, replace `` `TABBY_MEMORY_SYSMEM_PAGE_CACHE` `` with `` `TABBY_MEMORY_SYSMEM_KV_CACHE` `` inside the CacheRam `helpText` (rest of the sentence unchanged).

- [ ] **Step 5: Run the test — must PASS**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js managed-tabby
```

Expected: PASS.

- [ ] **Step 6: Confirm no stragglers in live code**

```bash
git grep -n "SYSMEM_PAGE_CACHE\|DRAFT_DYNAMIC" -- ':!docs'
```

Expected: no output (historical `docs/superpowers/plans/*.md` references stay as-is).

### Task 10: SiftKit full validation

- [ ] **Step 1: Full test suite**

```bash
npm run build:test && npm test
```

Expected: all pass.

- [ ] **Step 2: Typecheck + lint (typecheck script already chains lint)**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit (approved by user at check-in)**

```bash
git add src/inference-presets/exl3-preset-adapter.ts tests/managed-tabby.test.ts dashboard/src/settings-sections.ts
git commit -m "fix: adopt Tabby upstream env names (DYNAMIC_DRAFT, SYSMEM_KV_CACHE)

TabbyAPI merged upstream main, which renamed draft_dynamic -> dynamic_draft
and sysmem_page_cache -> sysmem_kv_cache; the old TABBY_* overrides are now
silently ignored by Tabby, so the adapter must emit the new names."
```

If not approved: leave staged-nothing, report the three modified files.

---

## Deferred follow-ups (documented, NOT part of this plan)

1. **Structured-output benchmark** (user decision gate): on the merged build with a live model, measure repeated json_schema request latency (first vs subsequent requests with the same schema, e.g. via `tests/req_json_schema.py`). Only if per-request LLGuidance filter construction is material, design an LLGuidance-side prototype cache as a fresh feature.
2. **`FormatronSchemaLowerer` re-evaluation** (`src/providers/formatron-schema-lowering.ts`): it force-requires all properties and null-wraps optionals — a workaround for Formatron's lack of optional-property support. LLGuidance handles optionals natively, so the lowering may now be an unnecessary semantic distortion (clients must emit `"field": null`). Keep behavior stable through the merge; revisit with the benchmark.
3. **Old config keys are silently dead**: any external `config.yml` still using `draft_dynamic:`/`sysmem_page_cache:` loses the setting without an error. SiftKit is covered by Task 9; nothing else known to use them.
4. **Stash cleanup**: `git stash list` in TabbyAPI holds the stale 1.4.3 pin edit; drop it once the merge is confirmed good (`git stash drop`).
