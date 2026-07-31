# EXL3 decode: upstream fix validation — exllamav3 `8e08af9` (2026-07-30)

**Status:** turboderp's fix is real and confirmed on this machine. It removes **both** defects
this repo measured: the `penalty_range` decode cost and the OpenMP spin. Nothing in SiftKit,
TabbyAPI, the venv or the model directory was modified; all measurement ran from copies in a
scratch directory.

Reads on from [`exl3-penalty-range-handoff-2026-07-30.md`](exl3-penalty-range-handoff-2026-07-30.md)
and [`exl3-penalty-range-validation-2026-07-30.md`](exl3-penalty-range-validation-2026-07-30.md).
Those documents' §12.1 / §12.2 upstream defects are the ones addressed here.

---

## 1. What the commit does

[`8e08af9`](https://github.com/turboderp-org/exllamav3/commit/8e08af9) — *"Generator: Copy job
pinned IDs to device memory for freq/pres/rep penalty kernels"*, authored 2026-07-30, on branch
`dev` only. **No release tag contains it** (latest tags: `v1.2.0`, `v1.2.1`). Two files, 17
insertions.

### 1.1 Tail-only staging — fixes handoff §12.2

`prepare_sampling_past_ids` keeps a `pinned_ids_valid` watermark and stages only the appended
tail instead of re-copying the whole sequence every token:

```python
n = len(self.sequences[0].sequence_ids)
if self.pinned_ids is None:
    ...
    self.pinned_ids_valid = 0
if self.pinned_ids_valid < n:
    self.pinned_ids[:, self.pinned_ids_valid : n].copy_(
        self.sequences[0].sequence_ids.torch_slice(self.pinned_ids_valid, n)
    )
    self.pinned_ids_valid = n
```

The watermark is clamped on the one place the sequence can shrink — the draft/banned-string
rewind at `job.py:779` — with `self.pinned_ids_valid = min(self.pinned_ids_valid, len(seq.sequence_ids))`.

This is exactly the "valid up to watermark" design handoff §12.2 proposed. The 1.07 MiB/token
CPU→pinned memcpy becomes 8 bytes/token, which is four orders of magnitude below ATen's
`GRAIN_SIZE` of 32,768 elements, so `at::parallel_for` never recruits the thread pool.

### 1.2 Device-resident `past_ids` — fixes the §4.2 PCIe cost

```python
self.current_pinned_ids = self.pinned_ids[:, :n]
self.current_device_ids = self.current_pinned_ids.to(self.logits_device, non_blocking = True)
```

and `sampler.forward` now receives `current_device_ids` instead of `current_pinned_ids`. The
penalty kernel is **unchanged** (`rep_pen.cu` has no commits between `v1.2.1` and `dev`); it
simply receives a device pointer. Its 61-block × window scan now reads VRAM rather than
streaming pinned host memory over PCIe, which is where the 65.5 MiB/token came from.

A third hunk sets `self.output_device = self.modules[-1].device` on the single-device load path
in `model/model.py` — previously `None` there, which hunk 1.2 would have tripped via
`logits_device`.

### 1.3 What it does not fix

Handoff §12.1 — `reqs_past_ids` latched before `alt()` simplifies the sampler chain — is
untouched. Fully neutral requests still stage IDs. Confirmed empirically below: on stock, the
`presence_penalty 0` arm still burns 11.5 cores.

---

## 2. Method

Comparing `dev` HEAD against `v1.2.1` directly would have been invalid twice over: `dev` has C
extension changes since `v1.2.1` (`bindings.cpp`, `cuda_host.cpp`, `q_cache.cu`, the new MLA
sources) that do not link against the installed `cp313` wheel's `.pyd`, and it carries ~50
unrelated commits (MLA, pagetable rewrite, tokenizer, second-tier CPU cache) that would
confound the result.

Instead the commit was isolated: `C:\envs\rl313\Lib\site-packages\exllamav3` was **copied** to
a scratch directory and the 8e08af9 diff applied to the copy, byte-for-byte and nothing else
(verified with `diff -rq` against the pristine install — exactly two files differ, exactly the
upstream hunks). The variant under test is selected purely by `PYTHONPATH`; `exllamav3_ext`
resolves to the installed `.pyd` either way, which is legitimate because the extension sources
are identical between `v1.2.1` and `dev`. Each run reports which package it imported and
whether the watermark is present.

| | |
|---|---|
| Engine interpreter | `C:\envs\rl313\Scripts\python.exe` — Python 3.13.14 |
| torch | 2.9.0+cu128, `torch.get_num_threads() == 12` |
| exllamav3 | 1.2.1 (`cp313` wheel) — stock, and the same tree + 8e08af9 |
| Model | `3.6_27b_4.7bpw`, `cache_size 150016`, `cache_mode 8,8` |
| MTP | disabled (it confounded tok/s in the prior investigation) |
| Launch env | **none** — no `OMP_NUM_THREADS`, no `KMP_BLOCKTIME` |
| Sampling | `temperature 0.6`, `presence_penalty 1.5`, `repetition_penalty 1.0`, min_p/top_k/top_p neutral |
| Workload | 256 tokens/arm, model loaded once per variant, one discarded warm-up job |
| CPU | `time.process_time()` inside the engine, split at the first streamed token |

The launch env is deliberately empty so the OpenMP spin is visible; SiftKit ships
`OMP_NUM_THREADS=1` and `KMP_BLOCKTIME=1`, which would mask it.

Two fixtures were used. `scripts/exl3-context-128k.txt` (131,057 tokens) is the repo's existing
one — **it is the word "benchmark" repeated, one distinct token id**, which is degenerate for a
penalty kernel that buckets by token id. A realistic 130,808-token fixture was therefore built
from SiftKit's own `src/*.ts`. Both are reported; they agree.

---

## 3. Results

Medians. Stock 3 reps / fixed 3 reps on the repo fixture; 2 reps each on the realistic one.
Within-arm spread is ≤0.7%.

### 3.1 Repo fixture, 131,057 tokens

| arm | stock tok/s | fixed tok/s | stock cores | fixed cores |
|---|---|---|---|---|
| `penalty_range` unbounded | 32.28 | **34.45** | 11.52 | **1.49** |
| `penalty_range 4096` | 34.78 | 34.68 | 11.51 | **1.45** |
| `presence_penalty 0` (ceiling) | 34.91 | 34.65 | 11.66 | **1.47** |

### 3.2 Realistic fixture, 130,808 tokens of SiftKit source

| arm | stock tok/s | fixed tok/s | stock cores | fixed cores |
|---|---|---|---|---|
| `penalty_range` unbounded | 32.39 | **34.81** | 11.68 | **1.38** |
| `penalty_range 4096` | 34.88 | 34.90 | 11.64 | **1.54** |
| `presence_penalty 0` (ceiling) | 35.09 | 34.92 | 11.52 | **1.37** |

### 3.3 What that says

- **The `penalty_range` cost is gone.** Bounding the range is worth **+7.70%** tok/s
  (2.21 ms/token) on stock and **+0.27%** (0.078 ms/token) on the fix — a 96% reduction of the
  defect. On the repo fixture the same figures are +7.77% → +0.66%. The stock arm reproduces
  the previously validated **+7.99%** to within a few tenths, which is what calibrates this
  harness against the earlier A/B.
- **The OpenMP spin is gone at the source.** 11.5–11.7 cores → 1.37–1.54, with **no launch-env
  workaround**. That is turboderp's "should only ever spin on one core" restored by fixing the
  memcpy rather than by capping the pool.
- **Prefill is unaffected**: 134.67 s stock vs 134.70 s fixed on the repo fixture, 142.10 vs
  136.79 on the realistic one — inside the ≥7% prefill noise floor established earlier. Prefill
  CPU is ~0.95–1.05 cores in both, unchanged, consistent with `prepare_sampling_past_ids` never
  running during prefill (handoff §5.5).
- **No throughput regression for already-bounded traffic**: `penalty_range 4096` moves +0.06%
  (realistic) / −0.30% (repo fixture) — noise in both directions.
- **Handoff §12.1 confirmed still live**: on stock, `presence_penalty 0` still costs 11.5–11.7
  cores, i.e. the copy runs even when both penalty steps are `alt()`-ed to no-ops.

### 3.4 The residual

Fixed-unbounded sits 0.27–0.66% below the penalty-off ceiling. The per-token H2D copy is
present in *every* fixed arm (because §12.1 still latches `reqs_past_ids`), so it cancels out of
that comparison; the residual is the kernel's own VRAM traffic — ~65 MiB/token at this depth and
vocab, ~65 µs at the 4090's bandwidth, which is the right order for 0.08–0.19 ms/token measured.

---

## 4. Correctness

Output-hash comparison across engines **does not work here, and the reason matters**: stock
exllamav3 1.2.1 is itself nondeterministic at this depth. Five identical seeded jobs
(`temperature 0.6`, `seed 1234`, same prompt, one process) produced **three distinct
completions** on stock and **three distinct completions drawn from the same set** on the fix.
The patched build is therefore no more and no less reproducible than the original, but neither
can be used as an equivalence oracle. Curiously, forcing the H2D copy to `non_blocking = False`
gave 5/5 identical — the blocking copy serialises enough to suppress the variance — but since
stock has no H2D copy at all and still varies, that is a side effect, not the source. The
source is unidentified and is **not** introduced by this commit.

The valid test is at the data level: assert that the staged device buffer equals the true
sequence at every step. An instrumented build compared
`current_device_ids.cpu()` against `sequences[0].sequence_ids.torch()` on every call to
`prepare_sampling_past_ids`, over 4 jobs × 64 tokens at 130,808-token depth:

```
STAGING MISMATCHES: 0
```

So the incremental watermark reconstructs the full sequence exactly, including across
prefix-cache reuse (jobs 1–3 ran with `cached_tokens 130560`). The rewind clamp at `job.py:779`
was **not** exercised — no banned strings, no draft rewind, MTP off — so that path remains
unverified here.

---

## 5. What this means for SiftKit — done 2026-07-30

The engine was upgraded and all three workarounds were removed the same day. §5.1 records the
upgrade, §5.2 the code change, §5.3 what is still owed.

### 5.1 Engine

`C:\envs\rl313` no longer runs the `1.2.1+cu128.torch2.9.0` wheel. It runs a source build of
the `dev` checkout at `C:\Users\denys\Documents\GitHub\exllamav3` @ `8e08af9` (tree clean, equal
to `origin/dev`). Reproduce with, from a `vcvars64.bat` shell:

```
set TORCH_CUDA_ARCH_LIST=8.9
set MAX_JOBS=10
set DISTUTILS_USE_SDK=1
C:\envs\rl313\Scripts\python.exe -m pip wheel . --no-deps --no-build-isolation -w <out>
```

~3 minutes; the single-arch `.pyd` is 34 MiB packed against the released wheel's ~1 GiB fat
build. CUDA 12.4 is a minor behind torch's cu128, which `cpp_extension._check_cuda_version`
warns about rather than rejects (same major). Rolling back means reinstalling upstream's
`exllamav3 1.2.1+cu128.torch2.9.0` wheel, or rebuilding the same way from tag `v1.2.1`.

**Verified after install, and only this far:** all three hunks present in the installed tree,
`exllamav3` and `exllamav3_ext` import, and `apply_pres_freq_pens` / `apply_rep_pens` execute
correctly on the 4090 (penalised ids get `-pres_p`, others `0`). **TabbyAPI was not booted and
no model was loaded** — the runtime DB has no EXL3 engine configured, so there was no
in-repo model path to smoke-test against. First real launch is the remaining gate.

**This is `dev` HEAD, not the isolated commit.** §2's whole method was to avoid the ~50
unrelated commits — MLA, the pagetable rewrite, tokenizer, second-tier CPU cache, and
`7858de8`, which flips fp16 prefill staging to default-on (`EXL3_QC_STAGING=0` to revert).
None of §3's numbers cover them.

### 5.2 Removed from SiftKit

- **`OMP_NUM_THREADS=1` and `KMP_BLOCKTIME=1`** — gone from `Exl3LaunchEnvironmentSchema` and
  from `buildLaunchEnvironment` in
  [`exl3-preset-adapter.ts`](../src/inference-presets/exl3-preset-adapter.ts). `EXL3_QC_ATTN=0`
  stays. The two `deepEqual` launch-environment fixtures in
  [`tests/model-preset-adapters.test.ts`](../tests/model-preset-adapters.test.ts) now assert
  their absence exactly.
- **`PenaltyRange`** — removed outright, not kept on the generation-quality grounds this
  section previously recommended (user decision). That deletes the preset field from
  `ManagedLlamaSettingsShape` and `ModelPresetFieldSchema`, its default, its normalization, its
  `PresetRequestDefaults` entry, the `penalty_range` branch of the request builder and of the
  passthrough route, the llama `removedFields` strip, and the dashboard control, help text and
  draft-editor key. The now-memberless `'exl3-only'` support kind went with it — no preset field
  is EXL3-only any more.
- Consequence to watch: presence penalty 1.5 again applies across the whole retrieval context,
  which is the defect handoff §10.1 describes — it suppresses the source the model is meant to
  quote. Nothing measures this today.

### 5.3 Still owed

- **Re-measure on the installed build.** §3 isolates one commit against 1.2.1; the venv now
  carries all of `dev`. `scripts/exl3-penalty-range-benchmark.ps1` is the runner, but see §6 —
  its fixtures are degenerate and must be replaced first.
- **Confirm the removals empirically**: decode cores with no `OMP_NUM_THREADS`, and tok/s with
  no `penalty_range`, on `dev` rather than on the patched-1.2.1 copy.
- **Generation quality with the penalty window unbounded**, per §5.2's last bullet.

---

## 6. Repo fixtures are degenerate

`scripts/exl3-context-{24k,64k,128k}.txt`, committed in `e650978`, are the single word
`benchmark` repeated to length — one distinct token across the whole context.
For a penalty kernel that buckets by token id and does `atomicAdd` per vocab block, that is a
pathological input: 60 of 61 blocks skip the atomic entirely and the 61st serialises on one
address. It happens not to have distorted the headline — the realistic fixture agrees to within
0.1 percentage points — but they should be replaced with real text, or
`scripts/exl3-penalty-range-benchmark.ps1` will silently stop measuring what it claims to
measure the moment anything content-sensitive is added to it.

---

## 7. Reproducing

Scratch directory `…\55d338ea-b52f-4678-888c-61dae43cd2cf\scratchpad`:

| file | what it is |
|---|---|
| `fixedpkg/` | copy of installed 1.2.1 with only the 8e08af9 diff applied |
| `penfix_bench.py` | loads once, runs the three arms × N reps, engine-side prefill/decode split + process CPU |
| `penfix_repeat.py` | determinism probe — N identical seeded jobs, hashes each |
| `penfix_equiv.py` | cross-engine output hashes (superseded by §4 — kept to show why it does not work) |
| `analyze.py` | reduces the JSON to the §3 tables |
| `ab-{stock,fixed}-128k.json`, `real-{stock,fixed}.json` | raw per-rep records |
| `rep-{stock,fixed,sync,check}.json` | §4 determinism and staging-invariant runs |
| `context-real.txt` | the 130,808-token realistic fixture |

Select the engine with `PYTHONPATH` — unset for stock, `…\fixedpkg` for the fix. Every script
prints the package it imported and whether the watermark is present; check that line before
trusting any number.

The `exllamav3` checkout at `C:\Users\denys\Documents\GitHub\exllamav3` was left on `dev`
@ `8e08af9` (it was previously on `master`).
