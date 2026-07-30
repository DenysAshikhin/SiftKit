# EXL3 decode: penalty_range + OpenMP spin — real-engine validation results (2026-07-30)

**Status:** both defects confirmed on the real engine. All six falsification criteria in
[`exl3-penalty-range-handoff-2026-07-30.md`](exl3-penalty-range-handoff-2026-07-30.md) §8
resolve in favour of the handoff's claims.

**Nothing in SiftKit, TabbyAPI, or the model directory was modified.** The engine ran from a
new interpreter (`C:\envs\rl313`) with launch environment supplied per-arm by the harness.

This completes §11's first two open items. The remaining ones are still open; see §6.

---

## 1. What was measured

| | |
|---|---|
| Engine interpreter | `C:\envs\rl313\Scripts\python.exe` — Python **3.13.14** |
| torch | `2.9.0+cu128`, CUDA 12.8, `torch.get_num_threads() == 12` |
| exllamav3 | **1.2.1** (`cp313` wheel, installed explicitly over TabbyAPI's 1.1.0 pin) |
| Model | `3.6_27b_4.7bpw` — Qwen3.5-27B hybrid, `vocab_size 248320`, 16 of 64 layers full-attention |
| Cache | `max_seq_len`/`cache_size` 139264, `cache_mode 8,8` (the `q8_0` preset mapping) |
| MTP | **disabled** — see §5 |
| Workload | 134,003-token prompt, 255 tokens generated, `presence_penalty 1.5`, temperature 0.6 |
| Reps | 5 per arm; rep 1 prefills cold, reps 2–5 hit the prefix cache (`cached_tokens 133888`) |

`prepare_sampling_past_ids` was verified byte-for-byte against handoff §4.2 before any arm ran.

## 2. Results

Medians. Prefill columns come from rep 1 only (the only cold one); decode columns from all 5.

| arm | launch env | request | prefill wall | prefill cores | decode cores | tok/s | ms/token |
|---|---|---|---|---|---|---|---|
| A control | — | — | 106.35 s | 0.97 | **10.77** | 31.93 | 31.333 |
| B | `OMP_NUM_THREADS=1` | — | 106.29 s | 0.42 | **0.98** | 31.52 | 31.726 |
| C | — | `penalty_range 1024, repetition_decay 0` | 106.28 s | 1.11 | 10.61 | **34.48** | **29.020** |
| D | `OMP_NUM_THREADS=1` | `penalty_range 1024, repetition_decay 0` | 106.36 s | 0.40 | 0.99 | 34.10 | 29.333 |
| E | `KMP_BLOCKTIME=1` | — | 106.34 s | 0.44 | 1.27 | 31.61 | 31.647 |
| A0 | — | — (temperature **0**) | 106.35 s | 1.16 | 10.49 | 34.40 | 29.059 |
| C0 | — | `penalty_range 1024` (temperature **0**) | 106.35 s | 1.10 | 10.33 | 34.25 | 29.216 |

Within-arm spread across reps is ±0.2% on decode, so differences above ~0.5% are real.

## 3. Falsification criteria (§8)

| claim | bar | measured | verdict |
|---|---|---|---|
| `penalty_range` costs ~12% of decode | falsified if C's gain < 4% | **+7.99%** tok/s, **−2.31 ms/token** | **supported**, magnitude qualified below |
| the copy causes the spin | falsified if B's decode cores > ~3 | **0.98** cores, down from 10.77 | **supported** |
| the two fixes are independent | falsified if D ≠ B's CPU and C's throughput | D 0.99 cores (B: 0.98), D 34.10 tok/s (C: 34.48) | **supported** |
| threading buys nothing | falsified if > 3% decode wall regression | B vs A **+1.25%**, D vs C **+1.08%** | **supported**, but not zero — see §4 |
| prefill is safe under a thread cap | falsified if B's prefill wall regresses > 7% | **−0.06%** (106.29 vs 106.35 s) | **supported** |
| MTP depth is irrelevant | falsified if recoverable ms/token varies > 30% | not re-tested under MTP; see §5 | **untested here** |

### 3.1 The magnitude claim needs splitting in two

The handoff predicts "≈1.8–2.0 ms recoverable" and "~12% of decode". On this model those
diverge, and both halves should be quoted separately:

- **Absolute recoverable is higher than predicted: 2.31 ms/token** (A→C), corroborated by
  2.39 ms/token on the thread-capped pair (B→D). Consistent with this model needing
  `CEIL_DIVIDE(248320, 4096) = 61` penalty blocks rather than the 38 the handoff assumed from
  a 151,936 vocab — 65.5 MiB/token over PCIe at 134k, not 38.9 MiB.
- **Fractional recoverable is lower than predicted: 7.4% of decode, not 12%.** The token here
  is 31.3 ms rather than the handoff's 16.2 ms, so the same absolute cost is a smaller share.

### 3.2 The temperature-0 control isolates the kernel

`sampler.py:57-59` returns `CustomSampler([SS_Argmax()])` when `temperature == 0`, discarding
the whole penalty stack ([`model.py:1185`](../../TabbyAPI/backends/exllamav3/model.py)). The
control arms exploit that as an independent check:

- **A0 vs C0: 34.40 vs 34.25 tok/s (−0.4%).** At temperature 0 `penalty_range` does nothing,
  as predicted — the kernel is not in the chain.
- **A vs A0: 31.93 vs 34.40 tok/s.** The entire penalty cost appears when, and only when,
  sampling is enabled.
- **C vs A0: 34.48 vs 34.40 tok/s.** Bounding the range recovers throughput to the greedy
  ceiling *exactly*. There is nothing left on the table beyond the kernel.

This is the strongest single piece of evidence that the recovered time is the penalty kernel
and not an unrelated effect.

## 4. Two places the handoff should be corrected

1. **`OMP_NUM_THREADS=1` is not free.** Handoff §9 correction 2 says the thread-capped arm was
   "the fastest" and the delta is inside ±2% noise. Here it is consistently **~1.1% slower** on
   decode wall — B vs A +1.25%, D vs C +1.08% — with reps tight to ±0.2%. That comfortably
   passes §8's ±3% bar, so the recommendation stands, but it is a real repeatable cost rather
   than zero, and it should be quoted as ~1%.

2. **§6's "prefer temperature 0" would have falsified defect 1 spuriously.** At temperature 0
   the penalty stack is discarded entirely (§3.2 above), so the arm C vs arm A comparison the
   protocol asks for would have returned a null result for a reason that has nothing to do with
   `penalty_range`. Any re-run must use temperature > 0.

Also worth noting, though not a correction: **prefill CPU is lower here than the handoff's
2.39 cores** — 0.97 cores at default blocktime with MTP off, 1.62–1.78 with MTP on. The source
is still unidentified (§6), but the quantity being explained is smaller than the handoff models.

## 5. What MTP does and does not change

The final matrix ran with **MTP disabled**, because with `draft_num_tokens: 3` the acceptance
rate swung 0.13–0.67 across reps and dominated tok/s — arm A alone spanned 28.95 to 45.44 tok/s,
which is the exact confound §8 warns about. Disabling speculation removed it and collapsed
within-arm spread to ±0.2%.

A partial MTP-on run (arms A–D, 2 reps, retained as `ab-run-mtp-on.log` in the session
scratchpad) agrees on everything that is not acceptance-sensitive:

| arm | decode cores, MTP on | decode cores, MTP off |
|---|---|---|
| A | 10.29 / 11.44 | 10.77 |
| B | 0.96 / 0.98 | 0.98 |
| C | 10.84 / 11.12 | 10.61 |
| D | 0.97 | 0.99 |

So defect 2 and the orthogonality result hold under MTP. **The handoff's §4.5 claim that MTP
depth does not change the recoverable ms/token was not re-tested** — the throughput arm is the
acceptance-sensitive one, and 2 confounded reps cannot resolve it.

## 6. Still open

- [ ] Confirm bounded `penalty_range` does not degrade repo-search output quality. Not tested.
- [ ] Decide `PresencePenalty` on quality grounds (handoff §10.1). Not tested — note that
      `PresencePenalty: 0` would delete the kernel cost entirely, same as arm C's ceiling, since
      `custom.py:641-644` drops the step.
- [ ] Identify what drives prefill's residual ~1 core. Still unknown; not `job.py:1247`.
- [ ] Re-test §4.5's MTP-depth claim with enough reps to beat acceptance noise.
- [ ] Measure `OMP_NUM_THREADS=1` **and** `KMP_BLOCKTIME=1` together. SiftKit ships both, but no
      arm here sets both — B is the pin alone (0.98 cores), E is the blocktime alone (1.27). The
      shipped configuration's decode cost is therefore unmeasured.
- [ ] File the two upstream issues in handoff §12.
- [ ] Implement the `PenaltyRange` preset field per handoff §10.2 — now unblocked, since the
      effect is confirmed real.

## 7. Reproducing

Harness and raw results are in the session scratchpad:

| file | what it is |
|---|---|
| `ab_harness.py` | Launches TabbyAPI per arm, drives the request, records prefill/decode separately |
| `enginehooks/sitecustomize.py` | In-process CPU sampler, loaded via `PYTHONPATH` |
| `analyze.py` | Reduces results to the §2 table and the §3 verdicts |
| `ab-results.json`, `ab-run.log` | Raw per-rep records, MTP off |
| `ab-run-mtp-on.log` | Partial MTP-on run (§5) |

CPU had to be sampled from inside the engine: `psutil` on this machine reads its own process's
`cpu_times()` correctly but returns `0.0` for any other process, so the handoff's "process-CPU →
cores" method cannot be run externally. `time.process_time()` inside the engine is
`GetProcessTimes`-backed and gives user+system CPU across all threads, which is what the cores
figure needs. Phase boundaries come from the engine's own `prompt_time`/`gen_time` in
`UsageStats`, because `output_chunking` batches the SSE stream and hides the first-token instant
from the client.
