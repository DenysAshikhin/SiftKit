# EXL3 CPU worker job merge: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the two pipelined row groups' jobs of a layer are both ready, the CPU worker runs them as one forward so each expert's weights stream once, with output bitwise equal to running them separately, and measure it in the production flow.

**Architecture:** In `exl3_moe_cpu_worker_run` the worker, after taking ring entry k, peeks at entry k+1; if it is published, same layer and kind, a different slot, and its `data_ready` has already landed, both jobs run through a new two-block forward (`exl3_moe_cpu_forward_raw2`) that addresses rows through per-token pointer tables, and both `done` flags are stored. A merged-jobs counter lives in the control block for tests and the profiler. Gated by `EXL3_MOE_MERGE_JOBS` (read with `getenv` in the worker, like `EXL3_MOE_CPU_SMALL_WORKERS`).

**Tech Stack:** exllamav3 C++ extension (`cpu/moe_handoff.cu`, `cpu/moe_mul1.cpp`), in-place build `cmd //c "C:/tmp/exl3-match/build-inplace.cmd"`, pytest worker protocol tests (CPU-only, `tests/kernels/moe_cpu_host/test_moe_worker.py` via `testlib/moe_handoff.py`), TabbyAPI harness for the benchmark.

**Spec:** `docs/superpowers/specs/2026-10-30-exl3-worker-job-merge-design.md`.

**Roles:** primary agent runs git, builds, tests, benchmarks; file edits go to the headless implementer (`claude -p --model claude-opus-5-5 --allowedTools "Read,Edit,Write,Grep,Glob" --add-dir C:\AI\exl3\dev-20261011\src`), prompts in `C:\tmp\exl3-match\impl\jmN.md`.

**Repo:** `C:\AI\exl3\dev-20261011\src`, branch `exp/zc-graph` (this lever stacks on the zero-copy work). Python `C:/AI/exl3/prod-20260924/venv/Scripts/python.exe`, `PYTHONPATH=.`. Worker protocol tests run with CUDA hidden (`run_isolated(..., env = {"CUDA_VISIBLE_DEVICES": ""})`), so they do not need the GPU.

---

## File map

| File | Responsibility |
|---|---|
| `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp`, `moe_mul1.h` | `exl3_moe_cpu_forward_raw2(handle, blocks, nblocks, topk, threads)`: the existing forward over several (x, sel, w, out, rows) blocks via per-token row pointers; `exl3_moe_cpu_forward_raw` becomes the one-block call of it |
| `exllamav3/exllamav3_ext/cpu/moe_handoff.h` | `MOE_MERGED_OFFSET 324` (u32 word 81, the `jobs_head` cache line): count of merged pairs |
| `exllamav3/exllamav3_ext/cpu/moe_handoff.cu` | worker loop: peek, merge conditions, two-block run, both `done` flags, counter, profiler fields |
| `exllamav3/model/moe_cpu_host.py` | `self.v_merged = u32[81:82]` mirror; `EXL3_MOE_MERGE_JOBS` documented in the module docstring |
| `tests/testlib/moe_handoff.py` | `MERGED = 324` constant (next to the other control words) |
| `tests/kernels/moe_cpu_host/test_moe_worker.py` | merge cases in `protocol_child` and three new tests |
| `tests/kernels/moe_cpu_host/test_host_layout` (existing `test_host_layout_matches_header`) | covers the new offset |
| `C:\tmp\exl3-match\jm-sweep.sh` | production-flow A B B A, merge on vs off |

---

### Task 1: Worker protocol tests for the merge

**Files:**
- Modify: `tests/testlib/moe_handoff.py` (add `MERGED = 324` beside the existing control-word constants)
- Modify: `tests/kernels/moe_cpu_host/test_moe_worker.py`

- [x] **Step 1: Add the cases to `protocol_child` (implementer, prompt `jm1.md`)**

After the "Pipelined: one job per slot, released out of order" block and before "Ring wraparound", insert:

```python
        # Merge: two same-layer gated jobs on different slots, both released before the worker reaches them,
        # run as one forward; outputs equal the separate forwards bitwise, both done flags land
        merged0 = seg.word(MERGED)
        seg.set_word(PASS_WAKE, seg.word(PASS_WAKE) + 1)      # keep the worker spinning hard
        a = job("merge_a", 0, 3, "partial", KIND_COMPUTE_GATED, release = False)
        b = job("merge_b", 0, 5, "partial", KIND_COMPUTE_GATED, release = False)
        seg.set_flag(DATA_READY, b[1], b[0])
        seg.set_flag(DATA_READY, a[1], a[0])
        for name, (seq, slot, (x, sel, w, mode, kind, layer, rows)) in (("merge_a", a), ("merge_b", b)):
            seg.wait(DONE, slot, seq)
            check(name, slot, layer, rows, x, sel, w, mode, kind)
        R["merged_pair"] = seg.word(MERGED) - merged0
        # No merge across layers or kinds: adjacent jobs of different layers run separately
        merged0 = seg.word(MERGED)
        a = job("nomerge_a", 0, 2, "partial", KIND_COMPUTE_GATED, release = False)
        b = job("nomerge_b", 1, 2, "partial", KIND_COMPUTE_GATED, release = False)
        seg.set_flag(DATA_READY, b[1], b[0]); seg.set_flag(DATA_READY, a[1], a[0])
        for name, (seq, slot, (x, sel, w, mode, kind, layer, rows)) in (("nomerge_a", a), ("nomerge_b", b)):
            seg.wait(DONE, slot, seq)
            check(name, slot, layer, rows, x, sel, w, mode, kind)
        R["merged_cross_layer"] = seg.word(MERGED) - merged0
        # The second job not ready: the first completes without waiting for it
        merged0 = seg.word(MERGED)
        a = job("late_a", 1, 3, "partial", KIND_COMPUTE_GATED, release = False)
        b = job("late_b", 1, 4, "partial", KIND_COMPUTE_GATED, release = False)
        seg.set_flag(DATA_READY, a[1], a[0])
        seg.wait(DONE, a[1], a[0])
        R["late_first_done_alone"] = seg.flag(DONE, b[1]) != b[0]
        seg.set_flag(DATA_READY, b[1], b[0])
        seg.wait(DONE, b[1], b[0])
        for name, (seq, slot, (x, sel, w, mode, kind, layer, rows)) in (("late_a", a), ("late_b", b)):
            check(name, slot, layer, rows, x, sel, w, mode, kind)
        R["merged_late"] = seg.word(MERGED) - merged0
```

`job()` must accept `release = False` with a `kind` argument in that position: check its signature (`job(name, layer, rows, mode = "random", kind = KIND_COMPUTE, release = True)`) and keep the calls positional as written. `check` already compares against `forward_ref` of the single job, which is the bitwise oracle.

Add the tests after `test_quit`:

```python
@pytest.mark.nogpu
def test_merge_same_layer_pair(protocol):
    assert protocol["merged_pair"] == 1
    assert not any(m.startswith("merge_") for m in protocol["mismatches"])


@pytest.mark.nogpu
def test_merge_not_across_layers(protocol):
    assert protocol["merged_cross_layer"] == 0


@pytest.mark.nogpu
def test_merge_never_waits_for_the_second_job(protocol):
    assert protocol["late_first_done_alone"]
    assert protocol["merged_late"] == 0
```

`protocol_child` runs the worker with the environment it inherits; `run_isolated`'s `env` for the fixture gains `"EXL3_MOE_MERGE_JOBS": "1"` so the feature is on in this run regardless of the default.

- [x] **Step 2: Run to see them fail (primary agent)**

```bash
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/kernels/moe_cpu_host/test_moe_worker.py -k "merge or protocol"
```

Expected: `test_merge_same_layer_pair` fails (`merged_pair == 0`: the word is unused so it reads 0); the other two pass trivially and act as guards once the merge exists. `test_host_layout_matches_header` must still pass (the offset constant is added in Task 2 to both header and Python).

---

### Task 2: Two-block forward in the CPU kernel

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp` (`ForwardCtx`, the four row-address sites at ~3271, ~3299, ~3389, ~3482, `exl3_moe_cpu_forward_raw`)
- Modify: `exllamav3/exllamav3_ext/cpu/moe_mul1.h`

- [x] **Step 1: Implement (implementer, prompt `jm2.md`)**

In `moe_mul1.h`:

```cpp
// One row block of a multi-block forward: rows of x/sel/wts/out are contiguous within a block
struct MoeCpuBlock
{
    const at::Half* x;
    const int32_t* sel;
    const at::Half* wts;
    float* out;
    int rows;
};

// Several row blocks in one forward: experts stream once for all blocks. Output of each block equals
// exl3_moe_cpu_forward_raw on that block alone, bitwise (rows are independent; per-row expert order unchanged)
void exl3_moe_cpu_forward_raw2(int64_t handle, const MoeCpuBlock* blocks, int nblocks, int topk, int threads);
```

In `moe_mul1.cpp`:
- `ForwardCtx` gains `std::vector<const at::Half*> x_rows; std::vector<float*> out_rows;` (one pointer per token), filled by the forward; the four sites address `c.out_rows[ch.token[r]]` instead of `c.out + ch.token[r] * H`, and `prepare_rows` gains an overload taking `const at::Half* const* rows` (gathering `rows[token[r]]` instead of `x + token[r] * H`), used at the two `prepare_rows(mat, c.x, ...)` sites. The `c.m_total == 1` test stays (total rows across blocks).
- `exl3_moe_cpu_forward_raw2`: `m_total = sum(rows)`; zero every block's `out`; per_expert grouping loops over blocks then rows with the global token index `t = block_base + r`, reading `sel`/`wts` from the block; `x_rows[t]`, `out_rows[t]` point into the block; the rest of the body (chunks, arena, pool run, profiling) is the existing code moved into this function.
- `exl3_moe_cpu_forward_raw(handle, x, sel, wts, out, rows, topk, threads)` becomes `MoeCpuBlock b{x, sel, wts, out, rows}; exl3_moe_cpu_forward_raw2(handle, &b, 1, topk, threads);`.

- [x] **Step 2: Build and run the existing kernel/worker suites (primary agent)**

```bash
cmd //c "C:/tmp/exl3-match/build-inplace.cmd" 2>&1 | grep -i "error\|BUILD EXIT" | head -5
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/kernels/moe_cpu_host tests/moe_cpu -k "not gpu_driven" 2>&1 | tail -3
```

Expected: build ok; everything that passed before passes (the one-block path is unchanged in behaviour). `test_compute_jobs_match_forward` is the bitwise guard for the refactor.

- [x] **Step 3: Commit**

```bash
git add exllamav3/exllamav3_ext/cpu/moe_mul1.cpp exllamav3/exllamav3_ext/cpu/moe_mul1.h
git commit -m "moe_cpu: multi-block CPU forward (rows addressed through per-token pointers); one-block forward is its special case"
```

---

### Task 3: Worker-side merge

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.h` (`#define MOE_MERGED_OFFSET 324` with the comment "merged job pairs (worker-written; jobs_head's line)")
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.cu` (`exl3_moe_cpu_worker_run`)
- Modify: `exllamav3/model/moe_cpu_host.py` (`self.v_merged = u32[81:82]` next to `v_jobs_head`; docstring line for `EXL3_MOE_MERGE_JOBS`)
- Modify: `tests/testlib/moe_handoff.py` (if `MERGED` was not added in Task 1)

- [x] **Step 1: Implement (implementer, prompt `jm3.md`)**

In the worker loop, after `const MoeJob job = jobs[head % MOE_JOB_RING]; head++; store_release_u32(jobs_head, head);` and after the job's own `data_ready` wait, add the peek:

```cpp
        // Merge with the next entry when it is the other row group's job of the same layer and its inputs
        // have already landed: experts both groups route to then stream once. Never waits for it.
        static const bool merge_ok = [](){ const char* e = getenv("EXL3_MOE_MERGE_JOBS"); return !e || atoi(e) != 0; }();
        bool merged = false;
        MoeJob job2;
        if (merge_ok && job.kind == MOE_JOB_KIND_COMPUTE_GATED
            && load_acquire_u32(ring_tags + (head % MOE_JOB_RING)) == head / MOE_JOB_RING + 1u)
        {
            job2 = jobs[head % MOE_JOB_RING];
            if (job2.kind == job.kind && job2.layer == job.layer && job2.slot != job.slot && job2.topk == job.topk
                && (int32_t)(load_acquire_u32(data_ready + size_t(job2.slot) * 16) - job2.seq) >= 0)
            {
                head++;
                store_release_u32(jobs_head, head);
                merged = true;
            }
        }
```

Then the compute block builds up to two `MoeCpuBlock`s (slot pointers `off_x`, `off_sel`, `off_w`, `off_out` of each job's slot), computes `run` over both blocks' `sel` (the existing all-inactive test, per block, OR-ed), calls `exl3_moe_cpu_forward_raw2(layer, blocks, merged ? 2 : 1, topk, threads)` when `run`, and stores `done` for `job` and then, if merged, for `job2` (`store_release_flag(done + size_t(job2.slot) * 16, job2)`). When merged, `store_release_u32(merged_word, load_acquire_u32(merged_word) + 1)` where `merged_word = ctrl + MOE_MERGED_OFFSET` (derive `ctrl` the way `jobs_head` is derived in this function). The profiler (`hprof`) gets `hp_merged` (pairs per 64 jobs) and `hp_overlap` (experts in both jobs' distinct sets, summed), printed as `merged %ld/64, overlap/pair %.2f`.

The gated all-inactive check for a merged pair: if one block is all-inactive and the other is not, still run both (the inactive block's rows produce zeros, which the collect kernel ignores for that job exactly as for a lone empty job: check `exl3_moe_split_collect_fused`'s empty-job rule and keep the per-job `done` semantics identical).

Python: `self.v_merged = u32[81:82]` after `self.v_jobs_head`; module docstring gains "EXL3_MOE_MERGE_JOBS (default 1): the worker runs the two pipelined row groups' jobs of a layer as one forward when both are ready".

- [x] **Step 2: Build, run the worker tests (primary agent)**

```bash
cmd //c "C:/tmp/exl3-match/build-inplace.cmd" 2>&1 | grep -i "error\|BUILD EXIT" | head -5
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/kernels/moe_cpu_host tests/moe_cpu -k "not gpu_driven" 2>&1 | tail -3
```

Expected: the three merge tests pass; `test_host_layout_matches_header` passes with the new offset; known failures unchanged.

- [x] **Step 3: Commit**

```bash
git add exllamav3/exllamav3_ext/cpu/moe_handoff.h exllamav3/exllamav3_ext/cpu/moe_handoff.cu exllamav3/model/moe_cpu_host.py tests/testlib/moe_handoff.py tests/kernels/moe_cpu_host/test_moe_worker.py
git commit -m "moe_cpu: worker merges the two row groups' ready jobs of a layer into one forward (EXL3_MOE_MERGE_JOBS)"
```

---

### Task 4: GPU-side checks (primary agent, GPU; after the user frees it)

- [x] **Step 1:** `tests/kernels/moe_cpu_host/test_moe_worker.py -k gpu_driven`, `tests/moe_cpu/test_moe_zc_pipeline.py`.
- [x] **Step 2:** `e2e_cap.py` at two groups with `EXL3_MOE_HANDOFF_PROF=1`: no errors; the profiler shows `merged` pairs per 64 jobs and the overlap.
- [ ] **Step 3:** `tests/generator/test_pipelined_pass.py` (groups 2) with the merge on: step-exact against eager (the merge is bitwise, so no new flips are expected).

---

### Task 5: Production-flow benchmark (primary agent, GPU)

- [x] **Step 1:** `C:\tmp\exl3-match\jm-sweep.sh` from `zc-sweep.sh`: arms are `EXL3_MOE_MERGE_JOBS` 0/1 at two groups with the accepted `EXL3_MOE_ZC`; `EXL3_MOE_HANDOFF_PROF=1` so each arm prints merge rate and overlap; `bash jm-sweep.sh "0 1 1 0"`.
- [x] **Step 2:** Record a subsection "Worker job merge" in `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` (A B B A decode, worker GB per pass, merge rate, overlap per pair, the verdict). If < 3%, set the default to off (`!e || atoi(e) != 0` becomes `e && atoi(e) != 0`) and commit `moe_cpu: job merge off by default`.

---

## Self-review

- Spec coverage: opportunistic merge conditions 1-3 (Task 3), two-block forward with bitwise equality (Task 2, guarded by `test_compute_jobs_match_forward` and the merge checks), profiler fields (Task 3), gating env (Task 3), tests 1-4 (Task 1), benchmark and acceptance (Task 5).
- Types: `MoeCpuBlock {x, sel, wts, out, rows}` and `exl3_moe_cpu_forward_raw2(handle, blocks, nblocks, topk, threads)` are the same in Task 2 and Task 3; `MERGED = 324` in the test library matches `MOE_MERGED_OFFSET 324` and `u32[81:82]`.
- The data-ready peek uses the same cyclic compare the job's own wait uses, so flag wraparound behaves identically.
