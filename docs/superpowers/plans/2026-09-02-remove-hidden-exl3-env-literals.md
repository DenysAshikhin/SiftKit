# Remove Hidden EXL3 Launch-Environment Literals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop SiftKit from silently injecting `EXL3_LOAD_ARENA=0` and `EXL3_QC_ATTN=0` into managed TabbyAPI launches so the child inherits exllamav3 defaults (or whatever the operator exports) for both.

**Architecture:** The managed EXL3 launch environment is a zod object built by `Exl3PresetAdapter.buildLaunchEnvironment()` and spread over `process.env` when `ManagedTabby.spawnProcess()` spawns TabbyAPI. Both literals are hard-coded `z.literal('0')` schema fields plus hard-coded `'0'` builder entries. Removal is deletion only: two schema fields, two builder fields, five test-fixture lines, and doc status updates. No replacement knob, no config field, no fallback.

**Tech Stack:** TypeScript, zod, `node:test` + `node:assert` via the repo test runner, npm scripts.

**Background the implementer needs:**

- `EXL3_LOAD_ARENA=0` was a temporary workaround from commit `41e67c55` for a peak-VRAM failure on EXL3 1.4.6. The user reports the upstream issue is fixed. Its handoff is `docs/exl3-load-arena-workaround-handoff-2026-09-02.md`.
- `EXL3_QC_ATTN=0` was a performance tuning from `docs/exl3-performance-tuning-2026-07-21.md`. The user wants it gone too so nothing is injected without a preset field.
- Tests use `assert.deepEqual` on the full launch-environment object, so deleting a key from the fixture makes the test fail until the adapter stops emitting it. That is the failing-test step.
- Tests run from bundles. Always `npm run build:test` before `npm test`. `npm run typecheck` already runs `npm run lint` at its tail.
- The launch environment is JSON-serialised as the managed-process signature (`src/status-server/managed-tabby.ts:88`). Removing keys changes the signature, so an already-running managed Tabby restarts on the next preset activation. That is expected.
- Do not touch `pristine_exle/` (vendored upstream), `.test-build/`, `.worktrees/`, or any dated historical doc other than the two named in Task 2.

**File map:**

| File | Change |
|---|---|
| `src/inference-presets/exl3-preset-adapter.ts` | Delete two schema fields and their comments, delete two builder entries. |
| `tests/model-preset-adapters.test.ts` | Delete two `EXL3_LOAD_ARENA` and two `EXL3_QC_ATTN` fixture lines. |
| `tests/managed-tabby.test.ts` | Delete one `EXL3_LOAD_ARENA` and one `EXL3_QC_ATTN` fixture line. |
| `docs/exl3-load-arena-workaround-handoff-2026-09-02.md` | Flip status to removed. |
| `docs/exl3-performance-tuning-2026-07-21.md` | Mark the `EXL3_QC_ATTN` action item and closing note as reverted. |

---

### Task 1: Remove both literals from the adapter, test-first

**Files:**
- Modify: `tests/model-preset-adapters.test.ts:69-70` and `tests/model-preset-adapters.test.ts:109-110`
- Modify: `tests/managed-tabby.test.ts:188-189`
- Modify: `src/inference-presets/exl3-preset-adapter.ts:39-46` and `src/inference-presets/exl3-preset-adapter.ts:120-121`

- [ ] **Step 1: Delete the expectations from the MTP launch-environment fixture**

In `tests/model-preset-adapters.test.ts`, the `deepEqual` starting at line 52 ends with:

```ts
    TABBY_MODEL_VISION: 'false',
    TABBY_MODEL_VISION_OFFLOAD: 'false',
    TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
    EXL3_LOAD_ARENA: '0',
    EXL3_QC_ATTN: '0',
  });
```

Change it to:

```ts
    TABBY_MODEL_VISION: 'false',
    TABBY_MODEL_VISION_OFFLOAD: 'false',
    TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
  });
```

- [ ] **Step 2: Delete the expectations from the non-speculative launch-environment fixture**

Same file, the `deepEqual` starting at line 93 ends with:

```ts
    TABBY_MODEL_VISION: 'false',
    TABBY_MODEL_VISION_OFFLOAD: 'false',
    TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
    EXL3_LOAD_ARENA: '0',
    EXL3_QC_ATTN: '0',
  });
  assert.equal('TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE' in adapter.buildLaunchEnvironment(preset), false);
```

Change it to:

```ts
    TABBY_MODEL_VISION: 'false',
    TABBY_MODEL_VISION_OFFLOAD: 'false',
    TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
  });
  assert.equal('TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE' in adapter.buildLaunchEnvironment(preset), false);
```

- [ ] **Step 3: Delete the expectations from the managed-child environment fixture**

In `tests/managed-tabby.test.ts` around line 186 the expected child environment ends with:

```ts
        TABBY_MODEL_VISION: 'false',
        TABBY_MODEL_VISION_OFFLOAD: 'false',
        TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
        EXL3_LOAD_ARENA: '0',
        EXL3_QC_ATTN: '0',
    });
```

Change it to:

```ts
        TABBY_MODEL_VISION: 'false',
        TABBY_MODEL_VISION_OFFLOAD: 'false',
        TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: '0',
    });
```

- [ ] **Step 4: Confirm no other test or source references remain besides the adapter**

Run:

```powershell
git grep -n "EXL3_LOAD_ARENA\|EXL3_QC_ATTN" -- src tests
```

Expected: exactly four hits, all in `src/inference-presets/exl3-preset-adapter.ts` (lines 40, 46, 120, 121). Any hit in `tests/` means a step above was missed.

- [ ] **Step 5: Rebuild test bundles and run the focused tests to verify they fail**

Run:

```powershell
npm run build:test
npm test -- model-preset-adapters managed-tabby
```

Expected: FAIL. Three tests fail with `AssertionError` from `deepEqual`, each diff showing the actual object carrying extra keys `EXL3_LOAD_ARENA: '0'` and `EXL3_QC_ATTN: '0'`. The failing tests are the two `buildLaunchEnvironment` contract tests in `model-preset-adapters` and the managed-child environment test in `managed-tabby`. If they pass, the bundles were not rebuilt.

- [ ] **Step 6: Delete the schema fields**

In `src/inference-presets/exl3-preset-adapter.ts`, inside `Exl3LaunchEnvironmentSchema`, this block:

```ts
  /** Per-job draft windows adapted from the acceptance EMA, capped by DRAFT_NUM_TOKENS. */
  TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: z.enum(['true', 'false']),
  /** Temporary upstream workaround: bypass the load arena to avoid peak-VRAM allocation failure. */
  EXL3_LOAD_ARENA: z.literal('0'),
  /**
   * exllamav3 defaults to quant-direct attention kernels for quantized caches; the
   * dequantize-then-attend path is ~7% faster at prefill and decode-neutral for ~240 MiB
   * extra peak VRAM. See docs/exl3-performance-tuning-2026-07-21.md.
   */
  EXL3_QC_ATTN: z.literal('0'),
  TABBY_MODEL_VISION: z.enum(['true', 'false']),
```

becomes:

```ts
  /** Per-job draft windows adapted from the acceptance EMA, capped by DRAFT_NUM_TOKENS. */
  TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: z.enum(['true', 'false']),
  TABBY_MODEL_VISION: z.enum(['true', 'false']),
```

- [ ] **Step 7: Delete the builder entries**

Same file, inside `buildLaunchEnvironment()`, this block:

```ts
      TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: preset.SpeculativeEnabled && preset.SpeculativeDynamic ? 'true' : 'false',
      EXL3_LOAD_ARENA: '0',
      EXL3_QC_ATTN: '0',
      TABBY_MODEL_VISION: preset.VisionEnabled ? 'true' : 'false',
```

becomes:

```ts
      TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: preset.SpeculativeEnabled && preset.SpeculativeDynamic ? 'true' : 'false',
      TABBY_MODEL_VISION: preset.VisionEnabled ? 'true' : 'false',
```

- [ ] **Step 8: Rebuild and run the focused tests to verify they pass**

Run:

```powershell
npm run build:test
npm test -- model-preset-adapters managed-tabby
```

Expected: PASS, all tests in both files green, zero failures.

- [ ] **Step 9: Confirm zero references remain in source and tests**

Run:

```powershell
git grep -n "EXL3_LOAD_ARENA\|EXL3_QC_ATTN" -- src tests
```

Expected: no output.

- [ ] **Step 10: Commit**

```powershell
git add src/inference-presets/exl3-preset-adapter.ts tests/model-preset-adapters.test.ts tests/managed-tabby.test.ts
git commit -m "feat(exl3): stop injecting EXL3_LOAD_ARENA and EXL3_QC_ATTN into managed launches"
```

---

### Task 2: Update the two docs that claim the literals are still shipped

**Files:**
- Modify: `docs/exl3-load-arena-workaround-handoff-2026-09-02.md:3-5`
- Modify: `docs/exl3-performance-tuning-2026-07-21.md:96-99` and `docs/exl3-performance-tuning-2026-07-21.md:139`

Other dated docs under `docs/` that mention `EXL3_QC_ATTN` are measurement history and stay untouched.

- [ ] **Step 1: Flip the handoff status**

In `docs/exl3-load-arena-workaround-handoff-2026-09-02.md`, replace lines 3-5:

```markdown
**Status:** active and temporary. The implementation is isolated in commit `41e67c55` on
`main`; this handoff is uncommitted. SiftKit-managed TabbyAPI launches force
`EXL3_LOAD_ARENA=0`. External TabbyAPI/EXL3 servers are unaffected.
```

with:

```markdown
**Status:** removed on 2026-09-02. The workaround from commit `41e67c55` was deleted after the
upstream streamed-tensor fix landed; SiftKit no longer sets `EXL3_LOAD_ARENA` and the managed
child inherits exllamav3's default (`1`) unless the operator exports another value. The rest of
this document is retained as history.
```

- [ ] **Step 2: Mark the QC_ATTN action item as reverted**

In `docs/exl3-performance-tuning-2026-07-21.md`, replace lines 96-99:

```markdown
- [x] Set `EXL3_QC_ATTN=0` in the managed TabbyAPI launch environment — done:
      `Exl3LaunchEnvironmentSchema` now carries it as a fixed `'0'` and
      `Exl3PresetAdapter.buildLaunchEnvironment` always emits it, so every managed EXL3
      launch (and the process signature that triggers restarts) includes it.
```

with:

```markdown
- [x] ~~Set `EXL3_QC_ATTN=0` in the managed TabbyAPI launch environment~~ — shipped as a fixed
      `'0'` in `Exl3LaunchEnvironmentSchema` from 2026-07-21, then **reverted on 2026-09-02** so
      SiftKit injects no engine environment that is not derived from a preset field. Operators
      who want the dequantize-then-attend path export `EXL3_QC_ATTN=0` in the shell that starts
      SiftKit; the managed child inherits the parent environment.
```

- [ ] **Step 3: Fix the closing note**

Same file, replace line 139:

```markdown
`EXL3_QC_ATTN=0` is unaffected and still shipped.
```

with:

```markdown
`EXL3_QC_ATTN=0` was still shipped at that point; it was removed on 2026-09-02 (see the action
items above).
```

- [ ] **Step 4: Commit**

```powershell
git add docs/exl3-load-arena-workaround-handoff-2026-09-02.md docs/exl3-performance-tuning-2026-07-21.md
git commit -m "docs(exl3): record removal of EXL3_LOAD_ARENA and EXL3_QC_ATTN injection"
```

---

### Task 3: Repository gates and live acceptance

**Files:** none modified.

- [ ] **Step 1: Typecheck and lint**

Run:

```powershell
npm run typecheck
```

Expected: exit 0. This script ends by running `npm run lint`, so a green typecheck covers lint. If it is slow to read, pipe through the smallest useful filter but do not skip it.

- [ ] **Step 2: Full test suite**

Run:

```powershell
npm run build:test
npm test
```

Expected: no new failures. At the time of the arena handoff the suite had two pre-existing unrelated failures, `assistant-migration.test.ts` and `runtime-db-schema-v51.test.ts`, both stale schema-version assertions expecting 55 against current 56. Any failure outside those two must be investigated before continuing. Report the exact pass, fail, and skip counts.

- [ ] **Step 3: Rebuild the runnable output**

Run:

```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 4: Live acceptance with a clean shell**

The literals overrode the parent environment, so the validation shell must not carry either variable or it will mask the result.

Run:

```powershell
Remove-Item Env:EXL3_LOAD_ARENA -ErrorAction SilentlyContinue
Remove-Item Env:EXL3_QC_ATTN -ErrorAction SilentlyContinue
npm run start:status:stable
```

Then activate the active managed EXL3 preset (the arena handoff workload: `3.8_27b_4.9bpw` at `max_seq_len=155000`, `cache_size=155136`, vision on, MTP on) and confirm:

1. Vision reaches 30/30, MTP draft reaches 3/3, main model reaches 67/67 in the Tabby startup log.
2. `/v1/models` and `/v1/model` return HTTP 200 and the startup run is recorded as `ready`.
3. One representative inference request completes with no CUDA allocation error.
4. Stop the instance, restart it once, and repeat 1-3 to exclude allocator state from a prior run.

If step 1 fails with `RuntimeError: Insufficient VRAM in split for model and cache`, the upstream fix has not actually landed in the configured interpreter. Stop, do not reduce context or disable vision/MTP, and report back: the user decides whether to re-add the arena workaround. Do not re-add `EXL3_QC_ATTN`.

- [ ] **Step 5: Stop validation processes**

Stop the status server and confirm ports 4765, 6876, and 8098 have no listeners:

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 4765, 6876, 8098 }
```

Expected: no output.

- [ ] **Step 6: Report**

State: the two commits, the focused and full-suite counts, typecheck/lint/build results, and the live acceptance outcome for both runs. Explicitly list anything not verified.
