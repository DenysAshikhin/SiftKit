# EXL3 decode: penalty_range + OpenMP spin — validation handoff (2026-07-30)

**Status:** root causes identified, reproduced in isolation, independently re-verified, and
**confirmed against the real engine** — see
[`exl3-penalty-range-validation-2026-07-30.md`](exl3-penalty-range-validation-2026-07-30.md).
All six §8 falsification criteria resolve in favour of the claims below. Two corrections to
this document are recorded in that one's §4: `OMP_NUM_THREADS=1` costs ~1% of decode wall
rather than nothing, and §6's "prefer temperature 0" advice is wrong — at temperature 0
`sampler.py:57-59` discards the entire penalty stack, so defect 1 is invisible.

**Nothing in the repo, the engine venv, or TabbyAPI has been modified.** All work so far is
measurement in a scratch directory. There is nothing to revert.

This supersedes [`exl3-decode-cpu-spin-2026-07-30.md`](exl3-decode-cpu-spin-2026-07-30.md).
That document's core mechanism is right; three of its specific claims are wrong and are
corrected in §9 below. Read this one, not that one.

---

## 1. Your task, in one paragraph

Build a Python 3.13 environment that can run TabbyAPI with exllamav3, load the same model at
the same context depth, and run a real-engine A/B to confirm or refute two independent
findings: (a) that bounding `penalty_range` recovers ~12% of decode throughput, and (b) that
`OMP_NUM_THREADS=1` drops host CPU from ~11.7 cores to ~1 without costing throughput —
including at prefill, which has never been measured under a thread cap. Everything below is
the background you need. §6 is the protocol; §8 is what would falsify each claim.

---

## 2. TL;DR of what was found

Three separate defects, all live, all independent of each other:

| # | Defect | Cost | Fixable where |
|---|---|---|---|
| 1 | Unbounded `penalty_range` → the penalty kernel scans the whole 134k context per token, 38.9 MiB over PCIe | **~1.8–2.0 ms/token, ~12% of decode** | SiftKit (send `penalty_range`) |
| 2 | A full-sequence CPU→pinned memcpy per token crosses ATen's `GRAIN_SIZE`, recruits all 12 OpenMP threads, which then spin for `KMP_BLOCKTIME` (200 ms default) | **~10.7 of 12 cores**, zero throughput effect | SiftKit (`OMP_NUM_THREADS=1`) |
| 3 | `PresencePenalty: 1.5` applied over the entire retrieval context | generation quality | SiftKit (`defaults.ts`) |

Defects 1 and 3 share a cause — nobody ever bounded the penalty window. Defect 2 is
mechanically unrelated and needs a different fix. **Neither fix helps the other**; this was
the prior document's main error.

---

## 3. Environment

### 3.1 What was measured on

| | |
|---|---|
| CPU | AMD Ryzen 9 7900X — 12 physical / 24 logical |
| GPU | NVIDIA GeForce RTX 4090 |
| Engine interpreter | `C:\envs\rl310\Scripts\python.exe` — Python **3.10.11** |
| torch | `2.9.0+cu128`, CUDA 12.8, `torch.get_num_threads() == 12` |
| exllamav3 | **1.2.1** (`exllamav3-1.2.1+cu128.torch2.9.0-cp310-cp310-win_amd64.whl`) |
| OpenMP runtime | `libiomp5md.dll` from `torch/lib`, confirmed loaded at runtime via `EnumProcessModules` |
| `KMP_SETTINGS=1` | `KMP_BLOCKTIME=200ms`, `KMP_LIBRARY=throughput`, `OMP_NUM_THREADS` not defined |
| TabbyAPI | `C:\Users\denys\Documents\GitHub\TabbyAPI` @ `04f32a4` |
| Model | `3.6_27B` from `D:\personal\models\elx3`, `cache_mode: 8,8` |
| Live TabbyAPI config | `max_seq_len: 84992`, `draft_mode: mtp`, `draft_num_tokens: 3`, `draft_cache_mode: Q8` |
| Profiled workload | ~134k context, MTP on, temperature 0.6 |

Note the live `config.yml` says `max_seq_len: 84992` while the profiled run was at ~134k —
SiftKit overrides it at launch via `TABBY_MODEL_MAX_SEQ_LEN`. See §3.3.

### 3.2 Building the 3.13 env — read this before you start

**Do not just `pip install -e .` in TabbyAPI.** Its `pyproject.toml` pins exllamav3 **1.1.0**:

```
"exllamav3 @ .../v1.1.0/exllamav3-1.1.0+cu128.torch2.9.0-cp313-cp313-win_amd64.whl ; platform_system == 'Windows' and python_version == '3.13'",
```

Every source line number in this document is from **1.2.1**. If you install 1.1.0 the file
offsets will not match and, more importantly, you may be measuring different code. Install the
cp313 build of 1.2.1 explicitly:

```
https://github.com/turboderp-org/exllamav3/releases/download/v1.2.1/exllamav3-1.2.1+cu128.torch2.9.0-cp313-cp313-win_amd64.whl
```

If no cp313 wheel of 1.2.1 exists, **stop and say so** rather than silently falling back — the
version difference invalidates the comparison against the numbers here. Verify after install:

```
python -c "import exllamav3, torch; print(torch.__version__, exllamav3.__file__)"
python -c "import exllamav3.generator.job as j, inspect; print(inspect.getsource(j.Job.prepare_sampling_past_ids))"
```

The second command must print the function shown in §4.2. If it differs, the line references
here are stale — re-locate them before trusting anything.

Other pins from the working 3.10 env, for reference:

```
torch 2.9.0+cu128 (https://download.pytorch.org/whl/cu128)
transformers==5.14.1   tokenizers==0.22.2   safetensors==0.8.0
numpy==2.2.6           pydantic==2.11.10    fastapi==0.139.2
uvicorn==0.37.0        ninja==1.13.0        flash-linear-attention==0.5.1
```

3.10 emits `Current Python version 3.10 is below the recommended 3.11 version` on every
TabbyAPI import — that warning is why you're building 3.13. It is cosmetic; it is not the
reason for any finding here.

### 3.3 How SiftKit launches the engine

[`managed-tabby.ts:188-190`](../src/status-server/managed-tabby.ts#L188) — the only spawn path:

```ts
const child = spawn(this.engine.PythonPath, [this.engine.Entrypoint], {
  cwd: this.engine.WorkingDirectory,
  env: { ...process.env, ...launchEnvironment },
```

Defaults from [`defaults.ts:106-112`](../src/config/defaults.ts#L106):

```
Managed: true
WorkingDirectory: C:\Users\denys\Documents\GitHub\TabbyAPI
PythonPath:       C:\envs\rl310\Scripts\python.exe     <-- point this at your 3.13 env
Entrypoint:       main.py
ModelRoot:        D:\personal\models\elx3
```

Environment is set on the child before `libiomp` initializes, so `OMP_NUM_THREADS` /
`KMP_BLOCKTIME` injected here take effect. `launchEnvironment` is built by
[`Exl3PresetAdapter.buildLaunchEnvironment`](../src/inference-presets/exl3-preset-adapter.ts#L63)
and validated by `Exl3LaunchEnvironmentSchema` — an exact zod object, so **adding a key
requires adding it to the schema**, and two tests `deepEqual` the whole environment
([`model-preset-adapters.test.ts:46`](../tests/model-preset-adapters.test.ts#L46) and
[`:80`](../tests/model-preset-adapters.test.ts#L80)).

---

## 4. Defect 1 — unbounded `penalty_range`

### 4.1 The window

`penalty_range` is a sliding window anchored at the **current position**, not at the prompt
boundary. It becomes two parameters (`TabbyAPI/backends/exllamav3/sampler.py:26-29`):

```python
def penalties(self, rep_p, freq_p, pres_p, penalty_range, rep_decay):
    self.stack += [
        SS_RepP(rep_p, penalty_range, rep_decay),
        SS_PresFreqP(pres_p, freq_p, penalty_range, rep_decay),
    ]
```

`penalty_range` → `sustain_range` (full penalty), `rep_decay` → `decay_range` (linear fade).

```
past_ids  [ ............... prompt ............... | generated ...... ]
          0                                                     past_len ^ now
                                  |<-- decay -->|<--- sustain --->|
          factor:  0        0     0 ....fade....1        1        1
```

`exllamav3_ext/generator/rep_pen.cu:166-181`:

```cpp
for (int i = threadIdx.x; i < past_len; i += NUM_THREADS)
{
    if (i <= past_len - sustain_range - decay_range)
        continue;
    int tid = (int) past_ids[i];
    if (tid < range_min || tid >= range_max)
        continue;
    float distf = (float)(past_len - i);
    float factor = decay_range > 0 ? 1.0f - (distf - sustain_rangef) / decay_rangef : 1.0f;
    factor = CLAMP(factor, 0.0f, 1.0f);
    atomicAdd(frequency + tid - range_min, factor * freq_p);
    shmemAtomicMaxF(presence + tid - range_min, factor * pres_p);
}
```

then `v -= frequency[i]; v -= presence[i];` at `:194-196`.

### 4.2 Why it costs what it costs

`num_blocks = CEIL_DIVIDE(vocab_size, 4096)` = **38 blocks** for a 151,936 vocab, and **every
block runs that loop independently** over the same window. `past_ids` is pinned host memory
read directly over PCIe — `rep_pen.cu:117` hands the host pointer to the kernel, which is the
entire reason for `pin_memory = True`:

```cpp
(const uint64_t*) past_ids.data_ptr(), \
```

So **bytes/token = 38 × window × 8 B**. At the full 134,317 that is 38.9 MiB/token → 1.554 ms
at PCIe 4.0 x16 line rate. There is **no VRAM cost** — the tensor never leaves host memory.

### 4.3 The default is -1, not "unset"

`TabbyAPI/common/sampling.py:167-168`:

```python
penalty_range: Optional[int] = Field(
    default_factory=lambda: get_default_sampler_value("penalty_range", -1),
```

`model.py:1137-1156`:

```python
penalty_range = unwrap(params.penalty_range, self.max_seq_len)   # unwrap only replaces None; -1 passes through
if penalty_range < 0:
    penalty_range = int(10e7)                                     # -> 100,000,000
...
if params.penalty_range < 0:
    fallback_decay = 0
else:
    fallback_decay = params.penalty_range
repetition_decay = coalesce(params.repetition_decay, fallback_decay, 0)
sampler_builder.penalties(..., penalty_range, max(repetition_decay, 1))
```

Effective today: **`sustain_range = 100,000,000`, `decay_range = 1`** — clamped by the kernel's
`past_len` bound to the whole sequence. SiftKit sends neither field (zero hits for
`penalty_range` across `src/`).

**Gotcha if you set it:** `fallback_decay = params.penalty_range` and `coalesce` returns the
first non-`None` (`common/utils.py:17-19`), so sending `penalty_range` alone **also sets
`decay_range` to the same value** — the scanned window doubles.

| you send | `sustain` | `decay` | scanned |
|---|---|---|---|
| nothing | 100,000,000 | 1 | 134,317 |
| `penalty_range: 1024` | 1024 | 1024 | **2048** |
| `penalty_range: 1024, repetition_decay: 0` | 1024 | 1 | 1025 |

### 4.4 Measured

Isolated kernel (`rep_pen_cost.py`), `apply_pres_freq_pens`, past_len 134,317, 38 blocks:

```
  penalty_range=100000000    1.554 ms/token    38.9 MiB   9.59% of a 16.2 ms token
  penalty_range=    32768    0.383 ms/token     9.5 MiB   2.36%
  penalty_range=    15000    0.182 ms/token     4.3 MiB   1.12%
  penalty_range=     8192    0.106 ms/token     2.4 MiB   0.66%
  penalty_range=     4096    0.058 ms/token     1.2 MiB   0.36%
  penalty_range=     2048    0.033 ms/token     0.6 MiB   0.20%
  penalty_range=     1024    0.020 ms/token     0.3 MiB   0.13%
  penalty_range=      256    0.015 ms/token     0.1 MiB   0.09%
```

Linear in window, flooring at ~0.015 ms of launch overhead (the loop still runs
`past_len / 1024` iterations per thread hitting the `continue`, touching no memory).

Decode-shaped loop (`penalty_range_decode.py` — copy → 16 ms forward → kernel → sync), 3 reps,
`OMP_NUM_THREADS=1`, medians, **ranges are the value you'd send so the window is 2×**:

| sent | window | ms/tok | tok/s | Δ vs no penalty |
|---|---|---|---|---|
| as shipped (-1) | 134,317 | 16.415 | 60.9 | **+1.466 (+9.8%)** |
| 16384 | 32,768 | 15.259 | 65.6 | +0.310 (+2.1%) |
| 8192 | 16,384 | 15.074 | 66.3 | +0.125 (+0.8%) |
| 4096 | 8,192 | 14.993 | 66.7 | +0.044 (+0.3%) |
| 2048 | 4,096 | 14.920 | 67.0 | −0.029 (noise) |
| 1024 | 2,048 | 14.904 | 67.1 | −0.045 (noise) |
| 256 | 512 | 14.879 | 67.2 | −0.070 (noise) |
| `PresencePenalty: 0` | — | 14.949 | 66.9 | — |

Isolated 1.554 ms vs decode-shaped 1.466 ms ⇒ **the cost is fully additive**, no overlap with
the forward. Expected — it is serialized on the sampling stream.

### 4.5 Under MTP (the live config is `draft_num_tokens: 3`)

MTP restructures the loop: one forward per step covering K+1 draft positions, then the
positions are verified sequentially. `generator.py:985` forces a host sync per position:

```python
if draft_tokens[j, i].item() != sampled_token.item() or cp_boundary:
```

so the K sampling ops are packed back-to-back and can never overlap. `mtp_penalty_range.py`,
K = accepted tokens/step, 2 reps, medians:

| sent | K=1 | K=3 | K=4 |
|---|---|---|---|
| no penalty | 13.24 | 13.22 | 13.19 |
| **as shipped** | **15.09** | **15.06** | **15.20** |
| 16384 | 13.66 | 13.63 | 13.71 |
| 8192 | 13.48 | 13.43 | 13.45 |
| 4096 | 13.39 | 13.30 | 13.40 |
| 2048 | 13.30 | 13.28 | 13.32 |
| 1024 | 13.26 | 13.24 | 13.35 |

Recoverable: 1.84 / 1.84 / 2.01 ms/token at K = 1 / 3 / 4. **MTP depth does not change it** —
the kernel fires once per sampled token regardless of batching, and the `.item()` sync
prevents overlap. If anything the *fraction* creeps up with K (12.2% → 13.2%) because the
forward's per-token share shrinks while the penalty's does not.

Caveat: 2 reps only, and the as-shipped arm is the unstable one (14.7–15.7 ms across reps —
it is the arm moving 38.9 MiB/token over PCIe, so it is contention-sensitive). Bounded arms
are tight to ±0.1 ms. **Treat "≈1.8–2.0 ms recoverable" as the honest range.**

---

## 5. Defect 2 — the memcpy and the OpenMP spin

### 5.1 The copy

`exllamav3/generator/job.py:1310-1317`:

```python
def prepare_sampling_past_ids(self):
    if not self.sampler.reqs_past_ids:
        return
    if self.pinned_ids is None:
        max_ids = max(len(seq.sequence_ids) for seq in self.sequences) + self.max_new_tokens + 8
        self.pinned_ids = torch.empty((1, max_ids), dtype = torch.long, pin_memory = True)
    self.current_pinned_ids = self.pinned_ids[:, :len(self.sequences[0].sequence_ids)]
    self.current_pinned_ids.copy_(self.sequences[0].sequence_ids.torch())   # <-- full sequence, every token
```

Called at `generator.py:841` (once per iterate step) and `generator.py:1005` (per accepted MTP
draft token). The slice is `[:, :len(sequence_ids)]` — **the whole sequence, unconditionally,
independent of `penalty_range`.** 134,317 × int64 = 1.07 MiB per token, re-copying an unchanged
prefix → O(n²) per generation.

### 5.2 Why 12 threads

1.07 MiB / 134,317 elements is above ATen's `at::parallel_for` `GRAIN_SIZE` of 32,768, so
`copy_` recruits the whole pool. Confirmed empirically — the discontinuity sits exactly there
(`past_ids_copy.py`, 12 threads):

```
ctx=  4096  us_per_copy=  1.6
ctx= 32768  us_per_copy=  4.2     <-- at GRAIN_SIZE, still cheap
ctx= 65536  us_per_copy= 13.6     <-- pool recruited
ctx=134317  us_per_copy= 21.9
```

The pool finishes in ~22 µs then busy-waits for `KMP_BLOCKTIME` (200 ms default, confirmed via
`KMP_SETTINGS=1`). Tokens arrive every ~16 ms, so it never reaches the sleep threshold.

**Python is not creating threads.** libiomp built the pool at import; this one memcpy keeps
kicking it. turboderp's position — that a spin while waiting on the GPU is deliberate but
"should only ever spin on one core" — is correct and is what the fix restores.

### 5.3 Measured

`past_ids_real.py`, 3 arms (re-run during validation; original doc's figures in parens):

| arm | copy alone | GPU wait alone | **decode loop** | ms/token |
|---|---|---|---|---|
| as shipped | 5.97 cores (7.66) | 1.20 (1.21) | **10.69 (11.24)** | 15.145 |
| `KMP_BLOCKTIME=1` | 5.81 (6.59) | 0.99 (0.98) | **1.32 (1.45)** | 14.778 |
| `OMP_NUM_THREADS=1` | 0.99 (0.71) | 0.99 (0.79) | **0.98 (0.72)** | 14.699 |

10.69 cores out of nothing but a memcpy and a `torch.cuda._sleep`, against **11.68 cores
measured in the real engine**. The "GPU wait alone" row (~1.0 core in every arm) is the
intended CUDA-sync spin and is not the problem.

**Wall cost of the threading: none.** Fork/join saves ~13 µs on a 14.6 ms token; the copy is
memory-bandwidth-bound and is *slower* threaded inside the real loop while costing 11× the
CPU. All arms within ±2%.

### 5.4 `KMP_BLOCKTIME` sweep (5 reps, 14.6 ms gap, medians)

| BT | decode cores | ms/token |
|---|---|---|
| 0 | 0.95 | 13.92 |
| **1** | **1.57** | 14.21 |
| 2 | 2.07 | 14.00 |
| 4 | 3.77 | 13.71 |
| 6 | 5.17 | 13.82 |
| 8 | 6.94 | 13.81 |
| 200 (default) | 11.56 | 13.75 |

Nothing to gain above 1 ms — CPU rises ~0.7 cores per additional millisecond and wall is flat
across every arm including the 200 ms default.

Gap sweep establishes the law:

```
  KMP_BLOCKTIME=1   gap=  4 ms  cores= 3.04     KMP_BLOCKTIME=8   gap=  4 ms  cores=10.10
  KMP_BLOCKTIME=1   gap=  8 ms  cores= 1.81     KMP_BLOCKTIME=8   gap=  8 ms  cores=11.29
  KMP_BLOCKTIME=1   gap= 16 ms  cores= 1.44     KMP_BLOCKTIME=8   gap= 16 ms  cores= 7.25
  KMP_BLOCKTIME=1   gap= 32 ms  cores= 1.15     KMP_BLOCKTIME=8   gap= 32 ms  cores= 3.42
  KMP_BLOCKTIME=1   gap= 64 ms  cores= 1.05     KMP_BLOCKTIME=8   gap= 64 ms  cores= 2.09
  KMP_BLOCKTIME=1   gap=128 ms  cores= 1.01     KMP_BLOCKTIME=8   gap=128 ms  cores= 1.47
```

**cores ≈ 1 + (N−1) · min(BT, gap) / gap**, fitting every cell to ~15% (slightly
over-predicts; the pool sleeps a touch early). Saturates at 12 once BT ≥ gap.

Under MTP the CPU is **K-invariant** (`mtp_penalty_range.py` with the pool restored):

| | K=1 | K=3 | K=4 |
|---|---|---|---|
| BT default | 11.56 / 11.73 | 11.82 / 11.81 | 11.75 / 11.72 |
| BT=1 | 1.59 / 1.63 | 1.63 / 1.36 | 1.66 / 1.26 |

(as-shipped / `penalty_range=1024`). Regions-per-second is set by tokens-per-second, which MTP
holds roughly constant, so batching does not change the ratio. Note `penalty_range=1024` leaves
CPU at ~11.7 cores — **the two defects are orthogonal at every K**.

### 5.5 Prefill — the part that is *not* measured

`prepare_sampling_past_ids` **never runs during prefill**. `generator.py:764-772`:

```python
for job in self.active_jobs:
    logit_mapping.append(len(input_ids_list))
    if not job.is_prefill_done(): continue      # <-- prefilling jobs never enter batch_jobs
    ...
    batch_jobs.append(job)
```

and both call sites iterate `batch_jobs`. So defect 2 costs **zero at prefill**.

Prefill nonetheless showed 2.39 cores at default blocktime vs 0.46 at BT=1. The source is
**unknown**. It is *not* `job.py:1247` (the page copy) — `PAGE_SIZE = 256` in `constants.py:2`,
so those copies are 2 KB, three orders under `GRAIN_SIZE`. The prior doc names that site; it is
wrong.

Fitting the §5.4 law to the two known points gives `1.93 = 11 × 0.200 × r` → **r ≈ 0.88
parallel regions/second**, i.e. one per ~1.14 s. That checks out independently: 190.9 s × 0.88
≈ 168 regions vs 134,317 ÷ 1024-token chunks = 131 chunks — roughly one CPU parallel region per
prefill chunk, exactly what a GPU-bound chunked forward would produce. Predicted:

| BT | prefill cores (predicted) |
|---|---|
| 1 | 0.47 (measured 0.46) |
| 8 | 0.54 |
| 200 | 2.39 (measured 2.39) |

**This is a model, not a measurement, and `OMP_NUM_THREADS=1` was never tried at prefill at
all.** It is the single largest open risk in the whole recommendation — see §6.3.

---

## 6. The A/B protocol

Run each arm at least **twice**. Prefer **temperature 0** to remove MTP-acceptance noise from
the comparison. Record **prefill and decode separately** — they behave differently and the
prior investigation conflated them. The noise floor on prefill wall is **≥7%** (see §9).

### 6.1 Arm matrix

| arm | launch env | request params | tests |
|---|---|---|---|
| A — control | none | none | baseline |
| B | `OMP_NUM_THREADS=1` | none | defect 2 |
| C | none | `penalty_range: 1024, repetition_decay: 0` | defect 1 |
| D | `OMP_NUM_THREADS=1` | `penalty_range: 1024, repetition_decay: 0` | both, no interaction |
| E (fallback) | `KMP_BLOCKTIME=1` | none | defect 2, weaker fix |

Arm D matters: the claim is that the two fixes are independent and additive. If D ≠ B's CPU
plus C's throughput, something in the model is wrong.

### 6.2 What to record per arm

- prefill wall (s) and prefill process-CPU (s) → cores
- decode wall, sampled tokens, tok/s, decode process-CPU → cores
- host CPU% from an external sampler as a cross-check on process-CPU
- `draft_num_tokens` and observed MTP acceptance rate (it moved between arms in the prior run
  and confounded the tok/s comparison — see §9)

### 6.3 Prefill under `OMP_NUM_THREADS=1` — do this deliberately

Arm B's prefill is the untested case. `OMP_NUM_THREADS=1` single-threads **every** CPU op in
the process, not just the one memcpy. Prefill's parallel regions are unidentified and may be
doing work where threading genuinely pays.

If arm B's prefill wall regresses more than the ~7% noise floor, `OMP_NUM_THREADS=1` is not
shippable as-is and arm E (`KMP_BLOCKTIME=1`, 1.3–1.6 cores) becomes the recommendation
instead. Say so plainly rather than averaging it away.

### 6.4 Expected results

| arm | decode cores | decode tok/s | prefill wall |
|---|---|---|---|
| A | ~11.7 | ~61.8 | baseline |
| B | **~1.0** | unchanged ±2% | **unknown — measure it** |
| C | ~11.7 (unchanged) | **~68, +10%** | unchanged |
| D | ~1.0 | ~68 | as B |
| E | ~1.3 | unchanged | unchanged (191.6 s measured previously) |

---

## 7. Repro scripts

In `%TEMP%\claude\c--Users-denys-Documents-GitHub-SiftKit\989ec5a7-968a-4050-95e9-f739c700b2bf\scratchpad\`:

| file | what it shows |
|---|---|
| `rep_pen_cost.py` | Penalty-kernel cost swept over `penalty_range`. §4.4 first table. |
| `penalty_range_decode.py` | Decode-shaped loop, `penalty_range` sweep. §4.4 second table. |
| `mtp_penalty_range.py` | Same under MTP; takes K as argv. §4.5 and §5.4 MTP table. |
| `blocktime_sweep.py` | `KMP_BLOCKTIME` sweep; `--gap` flag sweeps the inter-region gap. §5.4. |

In `...\6097bc00-5c18-4d05-bc24-2b6d2ac4c47f\scratchpad\` (earlier session):

| file | what it shows |
|---|---|
| `past_ids_real.py` | §5.3 — reproduces ~11 cores from the memcpy + a 16 ms GPU wait. |
| `past_ids_copy.py` | Copy cost vs depth, 12 threads vs 1. Locates `GRAIN_SIZE`. |
| `omp_spin.py` | Generic mechanism across blocktime and pool-size arms. |
| `verify.cjs` | Re-parses the five `sk_prof` logs. `node verify.cjs <logdir> [from] [to]`. |
| `dlls.py` | Confirms `libiomp5md.dll` is loaded in the engine process. |

Raw profiler logs in `...\7918a61f-3122-45de-bcf6-12f65c67ed0b\scratchpad\`
(`prof-baseline.log`, `prof-bt1.log`, `prof-bt0.log`, `prof-omp.log`, `sk_prof.log`) alongside
`backup/{job,generator}.py.orig`.

Run everything with the engine interpreter so the torch build matches. Env vars must be set
**before process start** — libiomp reads `KMP_BLOCKTIME` at init, so `os.environ[...]` inside
the script does nothing.

Note `rep_pen_cost.py` imports `from exllamav3.ext import exllamav3_ext as ext` — the
module-level `exllamav3.ext` has no `apply_rep_pens` attribute.

---

## 8. Falsification criteria

State plainly if any of these hold. Do not reconcile them into the existing story.

| claim | falsified if |
|---|---|
| `penalty_range` costs ~12% of decode | arm C's tok/s gain is < 4% at ≥100k context with acceptance rate held constant |
| the copy causes the spin | arm B's decode cores stay above ~3 |
| the two fixes are independent | arm D ≠ B's CPU and C's throughput |
| threading buys nothing | any arm shows > 3% decode wall regression from `OMP_NUM_THREADS=1` |
| prefill is safe under a thread cap | arm B prefill wall regresses > 7% vs arm A |
| MTP depth is irrelevant | recoverable ms/token varies > 30% across `draft_num_tokens` 1/3/5 |

The isolated repros are all n≥2 on a quiet machine; the real engine is n=1-per-arm historically
with a ≥7% prefill noise floor. **If a real-engine number disagrees with an isolated number,
the real engine wins** — but check acceptance rate before concluding, since that confounded the
prior run.

---

## 9. Corrections to the previous document

These are wrong in [`exl3-decode-cpu-spin-2026-07-30.md`](exl3-decode-cpu-spin-2026-07-30.md).
Do not propagate them.

1. **"Bound `penalty_range`… shrinks the copy ~65×, drops it under `GRAIN_SIZE`"** — false.
   `job.py:1316` slices by `len(sequence_ids)` regardless; `sustain_range` is only passed
   *through* to the kernel as a bound on the already-full tensor. Bounding the range does
   nothing for CPU. That document's §7.2 correctly frames the tail-slice as a *proposed engine
   change*; its §9.1 contradicts it.
2. **"`OMP_NUM_THREADS=1` costs ~0.2 ms/token (~1.3%)"** — not reproduced. In re-runs the
   thread-capped arm was the *fastest*. The delta is inside ±2% noise.
3. **"`penalty_range` defaults to `max_seq_len`"** — the default is `-1`, which
   `model.py:1140-1141` converts to `int(10e7)`. Same outcome, wrong mechanism.
4. **`job.py:1247` named as a prefill spin source** — `PAGE_SIZE = 256`, so those copies are
   2 KB, far under `GRAIN_SIZE`. The real prefill source is unidentified.
5. Also confirmed-and-carried-forward from that document's own §5 (these were *correct*):
   the PASSIVE arm's prefill regression is inside noise; `BLOCKTIME=0`'s decode "regression" is
   latency-only (that arm drew better MTP acceptance, +1.6% on tok/s); the `1488
   prompt_tokens_per_second` corroboration is unverifiable (`chat_messages` and
   `inference_runs` in `runtime.sqlite` are both empty — re-confirmed, still 0 rows); absolute
   pp tok/s figures rest on an assumed token count the profiler never recorded.

Everything else in that document's §5 table was re-derived from the raw logs with `verify.cjs`
and reproduces exactly.

---

## 10. Defect 3 and the SiftKit change in flight

### 10.1 The quality bug

`rep_pen.cu:180-181, 194-196` — presence penalty is a **flat additive subtraction from the
logit**, neutral at **0.0**. `RepetitionPenalty` is the multiplicative one, neutral at 1.0.
Penalties run *before* temperature (TabbyAPI applies `penalties()` then `temperature()`;
exllamav3 keeps them as the chain head at `custom.py:752`), so effective suppression is
`exp(pres_p / T)`:

| `PresencePenalty` | @ T=0.7 | @ T=0.6 |
|---|---|---|
| 0.0 | 1× (step dropped entirely) | 1× |
| 1.0 | 4.2× | 5.3× |
| **1.5** (current) | **8.5×** | **12.2×** |

Live value is `PresencePenalty: 1.5` from [`defaults.ts:51`](../src/config/defaults.ts#L51),
reached because the stored preset in `runtime.sqlite` is a migration stub
(`[{"id":"default","label":"Default"}]`, written by
[`runtime-db.ts:684-687`](../src/state/runtime-db.ts#L684)) and
[`normalization.ts:387-388`](../src/config/normalization.ts#L387) fills every absent field from
defaults. Nothing was ever explicitly configured.

**Critically, llama.cpp and EXL3 interpret that same number completely differently.**
`llama.h:1422-1426` — one window covers all three penalties:

```cpp
LLAMA_API struct llama_sampler * llama_sampler_init_penalties(
                         int32_t   penalty_last_n,   // last n tokens to penalize (0 = disable penalty, -1 = context size)
                           float   penalty_repeat,
                           float   penalty_freq,
                           float   penalty_present);
```

and `common/common.h:238` defaults `penalty_last_n = 64`. SiftKit never sends `repeat_last_n`
and `managed-llama.ts:580-595` never passes `--repeat-last-n`, so:

| | window for `PresencePenalty: 1.5` |
|---|---|
| llama.cpp | last **64** tokens |
| EXL3 | all **134,317** tokens |

The 1.5 was almost certainly tuned against llama's behavior and EXL3 silently reinterpreted it.
That is the origin of defect 3, not the number itself.

### 10.2 Change in flight — not yet implemented

Adding a `PenaltyRange` preset field, default `-1`, **EXL3-only** (user decision, twice
affirmed after being shown llama's 64-token window). Design settled, no code written:

- `PenaltyRange: z.number()` in `ManagedLlamaSettingsShape` and `'PenaltyRange'` in
  `ModelPresetFieldSchema` — [`packages/contracts/src/config.ts`](../packages/contracts/src/config.ts)
- `PenaltyRange: -1` in [`defaults.ts`](../src/config/defaults.ts)
- interface field + `getFiniteInteger` line in [`normalization.ts`](../src/config/normalization.ts)
- `penaltyRange` in `PresetRequestDefaultsSchema` / `buildPresetRequestDefaults`, and an
  early-return in `getPresetFieldAvailability` returning
  `{ enabled: false, reason: 'Not supported by llama.cpp' }` for llama (TS narrowing then keeps
  the exhaustive switch valid without a new case) —
  [`preset-compatibility.ts`](../src/inference-presets/preset-compatibility.ts)
- `penalty_range` in the exl3 branch of
  [`inference-request-builder.ts`](../src/llm-protocol/inference-request-builder.ts), plus
  `penalty_range` added to llama's `removedFields` in
  [`request-compatibility.ts`](../src/inference-presets/request-compatibility.ts) so the
  passthrough strips it — which lets `inference-passthrough.ts:114` set the default
  unconditionally with no new branch
- dashboard: `ModelIntegerField` union, `ModelPresetsSection.tsx` input,
  `settings-sections.ts` helpText
- tests: `model-preset-adapters.test.ts` (availability + request defaults),
  `inference-request-builder.test.ts` (present for exl3, absent for llama),
  `settings-sections.test.ts` label list

**`-1` is sent verbatim** — it is already TabbyAPI's default, so it is a no-op and needs no
omit-logic special case.

The A/B has now confirmed the effect is real (+7.99% tok/s, −2.31 ms/token), so this is
unblocked. If you implement it,
remember `Exl3LaunchEnvironmentSchema` is exact and two tests `deepEqual` the full environment
(§3.3) — that applies to any launch-env var such as `OMP_NUM_THREADS`.

---

## 11. Open items

- [x] Real-engine A/B per §6. Both fixes confirmed, and arm D confirms independence.
- [x] **Prefill under `OMP_NUM_THREADS=1`** — measured: **−0.06%** wall against a ≥7% noise
      floor, while prefill CPU drops 0.97 → 0.42 cores. Safe; arm E is not needed.
- [ ] Identify what actually drives prefill's residual CPU. Not `job.py:1247`. Measured at
      ~0.97 cores, lower than the 2.39 this document models.
- [ ] Confirm bounded `penalty_range` does not degrade repo-search output quality.
- [ ] Decide `PresencePenalty` on quality grounds — 1.5 over a retrieval context is likely
      wrong regardless of window, and `0` deletes the entire 1.55 ms/token kernel cost since
      `custom.py:641-644` drops the step. It does **not** delete the copy (see §12).
- [ ] File two upstream issues with turboderp (§12).
- [ ] If a launch-env var is adopted, document the rationale in
      [`exl3-performance-tuning-2026-07-21.md`](exl3-performance-tuning-2026-07-21.md) next to
      the `EXL3_QC_ATTN` note.

---

## 12. Upstream defects (exllamav3 / TabbyAPI)

**12.1 `reqs_past_ids` is latched before the sampler chain is simplified.**
`exllamav3/generator/sampler/custom.py:739-746`:

```python
for step in steps:
    self.reqs_past_ids = self.reqs_past_ids or step.reqs_past_ids()   # read pre-alt()
    self.reqs_torch_seed = self.reqs_torch_seed or step.reqs_torch_seed()
    alt = step.alt()
    if alt:
        step = alt
    if not isinstance(step, SS_NoOp):
        simplified.append(step)
```

Both penalty steps return `True` unconditionally (`:581`, `:646`) and both `alt()` to `SS_NoOp`
when neutral (`:576-579`, `:641-644`). The step is dropped from the chain but the flag is
already set — so **every** EXL3 request through TabbyAPI pays the O(n)-per-token copy,
including fully neutral `rep_p=1.0, pres_p=0, freq_p=0` ones. One-line fix: latch from the
post-`alt()` step. Affects every TabbyAPI user, not only deep-context ones.

Note TabbyAPI's `max(repetition_decay, 1)` guarantees `sustain_range + decay_range > 0`, so the
other `alt()` disjunct can never fire — the neutral-penalty branch is the only live one.

**12.2 The copy is O(context) per token → O(n²) per generation.** `pinned_ids` is already
persistent and the sequence grows by 1–N tokens per step, so only the appended tail needs
copying. Requires a "valid up to" watermark invalidated on `SeqTensor.truncate` / draft rewind
(`job.py:768`, banned-string rewind). Separately, `sustain_range + decay_range` bounds what the
kernel actually reads, so the copy could be a tail slice — at ≤32,768 elements it would fall
under `GRAIN_SIZE` and never touch the pool, fixing defect 2 upstream as well.

This is also the correct explanation for the observed context scaling — not "deeper context →
longer GPU wait → more spin," but "the per-token copy itself grows with depth."
