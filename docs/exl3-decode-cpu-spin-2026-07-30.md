# EXL3 decode CPU spin — investigation handoff (2026-07-30)

Status: **root cause identified and reproduced in isolation. No code change landed yet.**
Nothing in the repo or the engine venv has been modified by this investigation.

---

## 1. Symptom

During `siftkit repo-search` runs against the managed EXL3 backend, host CPU sat at a flat
~80% of a 12-core machine for the entire generation — roughly 11.7 cores — at ~60 tok/s.
The 3%↔50% fluctuation observed around tool calls was the same load starting and stopping.
CPU per token grew with context depth while tok/s barely moved.

Prefill was also elevated but far less so (~2.4 cores).

## 2. Environment under test

| | |
|---|---|
| CPU | AMD Ryzen 9 7900X — 12 physical / 24 logical cores |
| Engine interpreter | `C:\envs\rl310\Scripts\python.exe` (Python 3.10.11) |
| torch | 2.9.0+cu128, `torch.get_num_threads() == 12` |
| OpenMP runtime | `libiomp5md.dll` from `torch/lib` — confirmed loaded at runtime via `EnumProcessModules` |
| `KMP_SETTINGS=1` dump | `KMP_BLOCKTIME=200ms`, `OMP_NUM_THREADS` not defined |
| exllamav3 | `C:\envs\rl310\lib\site-packages\exllamav3` |
| TabbyAPI | `C:\Users\denys\Documents\GitHub\TabbyAPI` |
| Workload | ~134k context, MTP speculation on, temperature 0.6 |
| Launch path | [managed-tabby.ts:188-190](../src/status-server/managed-tabby.ts#L188) — `spawn(engine.PythonPath, …, { env: { ...process.env, ...launchEnvironment } })`; the only path, and it sets env before libiomp initializes in the child |

## 3. How the first round of data was collected

`job.py` and `generator.py` in the engine venv were temporarily patched with `sk_prof`
phase timers (wall + process CPU per phase, dumped every N iterate steps). Four arms were
run, one run each:

- `prof-baseline.log` — no OMP env set
- `prof-bt1.log` — `KMP_BLOCKTIME=1`
- `prof-bt0.log` — `KMP_BLOCKTIME=0`
- `prof-omp.log` — `KMP_BLOCKTIME=0` + `OMP_WAIT_POLICY=PASSIVE` + `OMP_NUM_THREADS=2`
- `sk_prof.log` — an earlier default-config run, coarser dump interval

Logs live at
`%TEMP%\claude\c--Users-denys-Documents-GitHub-SiftKit\7918a61f-3122-45de-bcf6-12f65c67ed0b\scratchpad\`
alongside `backup/{job,generator}.py.orig`.

**The instrumentation has been fully reverted.** `job.py` and `generator.py` in
`C:\envs\rl310\lib\site-packages\exllamav3\generator\` are byte-identical to those `.orig`
backups and contain zero `sk_prof` references. Nothing to clean up.

## 4. First conclusion (partly right, wrong level)

The initial read was: this is a libiomp spin-wait. `KMP_BLOCKTIME` defaults to 200 ms, so
after every parallel region the pool busy-waits 200 ms before sleeping; at ~16 ms/token it
never reaches the sleep threshold. Proposed fix was `KMP_BLOCKTIME=1` in
`Exl3LaunchEnvironmentSchema`.

That diagnosis of the *mechanism* is correct and was independently confirmed (§5). It is
not the *root cause* — it explains why the CPU stays burnt, not why 12 threads are being
woken every token in the first place.

turboderp (exl3 author) pushed back on exactly that point: a CPU spin while reading the
sampled token off the end of the forward pass is expected and deliberate — you don't want
to `sleep()` the process because that adds wake-up latency when the token is ready — but
**it should only ever spin on one core**, and Python has no reason to be creating threads.
They were right, and lowering the blocktime is treating the aftermath.

## 5. Verification of the first round (independent re-parse + repro)

Re-parsed all five logs from scratch. Widest window all four arms share is iterate steps
150→500 (350 steps, ~1150–1230 sampled tokens).

| arm | decode cores | prefill wall | prefill cores | per-step wall Δ | sampled tok/s Δ |
|---|---|---|---|---|---|
| baseline | 11.68 | 190.9 s | 2.39 | — | — |
| `KMP_BLOCKTIME=1` | **1.33** | 191.6 s | **0.46** | +0.47% | +2.3% |
| `KMP_BLOCKTIME=0` | 0.93 | 250.9 s | 0.42 | +5.2% | +1.6% |
| PASSIVE+BT0+2thr | 0.89 | 204.8 s | 0.42 | +28.4% | −18.1% |

Confirmed: −88.6% decode CPU and −80.7% prefill CPU for `KMP_BLOCKTIME=1` at +0.4% wall.
Mechanism confirmed separately — a standalone loop of one small CPU tensor op plus a GPU-only
wait burns 4.7–9.5 cores at default blocktime and ~1 core with the pool capped, while the
same loop with *no* CPU op at all sits at 0.99 cores in every arm. Spin scales linearly with
pool size at default blocktime: `OMP_NUM_THREADS` 1 → 0.96 cores, 2 → 1.17, 4 → 3.70, 12 → 9.57.

**Claims from the first round that did NOT survive:**

- *"PASSIVE arm costs 7.3% on prefill"* — the earlier default-config run (`sk_prof.log`)
  recorded prefill at 204.4 s / 1.92 cores vs `prof-baseline`'s 190.9 s / 2.39 cores. That is
  a ≥7% wall / ~20% CPU run-to-run spread on what looks like the same workload, so the PASSIVE
  arm's 204.8 s is inside noise. (Caveat: that run used a coarser dump interval and possibly an
  earlier patch revision, so instrumentation difference isn't fully excluded.)
- *"BLOCKTIME=0 costs 5.3% on decode"* — reproduces only on per-iterate-step wall (+5.2%).
  On sampled tok/s that arm is +1.6% vs baseline; it drew better MTP acceptance. Latency
  regression yes, throughput regression not shown.
- *"BLOCKTIME=0 costs 31.5% on prefill"* — directionally real and **not** a cold-start artifact
  (per-window deltas +40% / +29% / +21%, uniform), but n=1 against a ≥7% noise floor. Don't
  quote the magnitude as precise.
- *"1488 prompt_tokens_per_second in chat_messages corroborates the harness"* — unverifiable;
  `chat_messages` and `inference_runs` in `C:\Users\denys\.siftkit\runtime.sqlite` are both empty.
- Absolute pp tok/s figures (1408 etc.) rest on an assumed 2 × 134,317 prefill tokens that the
  profiler never recorded. Ratios are fine; absolutes are an assumption.

## 6. Root cause

One op in the per-token path opens a CPU parallel region over ~1 MB.

[`exllamav3/generator/job.py:1310-1317`](C:\envs\rl310\lib\site-packages\exllamav3\generator\job.py#L1310)

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

Called at `generator.py:841` once per iterate step, and again at `generator.py:1005` per
accepted MTP draft token.

At 134k context that final line is a **134,317 × int64 = 1.07 MB CPU→pinned memcpy per token**.
ATen's CPU `copy_` goes through `at::parallel_for` with `GRAIN_SIZE = 32768`, so anything over
32k elements recruits the whole 12-thread pool. The pool finishes in ~22 µs, then busy-waits
200 ms; the next token arrives in ~16 ms, so it never sleeps.

Python is not creating threads. libiomp created the pool at import. This one memcpy is what
keeps kicking it.

### Repro — this alone accounts for the entire observed load

`past_ids_real.py`: `dst.copy_(src)` over 134k int64 into a pinned buffer, plus
`torch.cuda._sleep()` calibrated to ~16 ms (60 tok/s), in the engine venv.

| config | copy alone | GPU wait alone | **decode loop** | ms/token |
|---|---|---|---|---|
| as shipped | 7.66 cores | 1.21 cores | **11.24 cores** | 14.615 |
| `KMP_BLOCKTIME=1` | 6.59 | 0.98 | **1.45** | 14.752 |
| `OMP_NUM_THREADS=1` | 0.71 | 0.79 | **0.72** | 14.927 |

11.24 cores out of a memcpy and a sleep, against 11.6–11.7 in the real engine run. The
"GPU wait alone" row is turboderp's expected single spinning core — it is ~1.0–1.2 cores in
every arm and is not the problem.

Note the copy is *slower* threaded inside the real loop and costs 11× the CPU: a 1 MB memcpy
is memory-bandwidth-bound, so the fork/join buys ~13 µs out of a 14.6 ms token.

Copy cost by depth (12 threads vs 1), showing the `GRAIN_SIZE` threshold:

| context | 12 threads | 1 thread |
|---|---|---|
| 4,096 | 1.9 µs | 1.3 µs |
| 32,768 | 5.1 µs | 4.5 µs |
| 65,536 | 20.9 µs | 10.4 µs |
| 134,317 | 42.0 µs (5.59 cores) | 18.4 µs |

(Windows process-CPU granularity is ~15.6 ms, so per-copy CPU figures at these magnitudes are
tick-quantized — read the wall column and the aggregate cores, not the small CPU numbers.)

## 7. Two upstream defects in exllamav3 / TabbyAPI

**7.1 `reqs_past_ids` is latched before the sampler chain is simplified.**

[`exllamav3/generator/sampler/custom.py:739-746`](C:\envs\rl310\lib\site-packages\exllamav3\generator\sampler\custom.py#L739)

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

`SS_RepP.alt()` returns `SS_NoOp` when `rep_p == 1.0`; `SS_PresFreqP.alt()` returns `SS_NoOp`
when `pres_p == 0.0 and freq_p == 0.0`. The step is then dropped from the chain — but the flag
was already set from the un-simplified step. And TabbyAPI's
`backends/exllamav3/sampler.py:26-29` appends **both** steps unconditionally:

```python
def penalties(self, rep_p, freq_p, pres_p, penalty_range, rep_decay):
    ...
    SS_RepP(rep_p, penalty_range, rep_decay),
    SS_PresFreqP(pres_p, freq_p, penalty_range, rep_decay),
```

Net effect: **every** EXL3 request through TabbyAPI pays the O(n)-per-token copy, including
fully neutral `rep_p=1.0, pres_p=0, freq_p=0` requests where both steps are discarded.
Fix is one line — latch the flag from the post-`alt()` step.

**7.2 The copy is O(context) per token → O(n²) per generation, re-copying an unchanged prefix.**

`pinned_ids` is already a persistent buffer and the sequence only grows by 1–N tokens per step,
so only the appended tail needs copying. Requires a "valid up to" watermark invalidated on
`SeqTensor.truncate` / draft rewind (`job.py:768`, banned-string rewind). Separately,
`sustain_range + decay_range` bounds what the rep-pen kernel actually reads, so the copy could
be a tail slice; at ≤32768 elements it would fall under `GRAIN_SIZE` and never touch the pool.

This is also the correct explanation for the observed context scaling — not "deeper context →
longer GPU wait → more spin," but "the per-token copy itself grows with depth."

## 8. What amplifies it on the SiftKit side

- `TabbyAPI/backends/exllamav3/model.py:1138`:
  `penalty_range = unwrap(params.penalty_range, self.max_seq_len)`.
  SiftKit never sends `penalty_range` — it is not in `PresetRequestDefaultsSchema`
  ([preset-compatibility.ts:12-25](../src/inference-presets/preset-compatibility.ts#L12)) — so it
  defaults to the full 134k.
- [defaults.ts:51-52](../src/config/defaults.ts#L51): `PresencePenalty: 1.5`,
  `RepetitionPenalty: 1.0`. Presence penalty is non-neutral, so `SS_PresFreqP` survives `alt()`
  and the past-ids copy is genuinely required by the kernel — SiftKit is not merely tripping 7.1.

**This is also a generation-quality bug, independent of CPU.** Presence penalty 1.5 applied
over the entire 134k window penalizes every token that appeared anywhere in the prompt. For
repo-search that is the retrieved source code the model is supposed to quote verbatim.

## 9. Recommendations, ranked

1. **Bound `penalty_range`.** Add it to `PresetRequestDefaults` / the request builder and set it
   to something sane (~2048). Shrinks the copy ~65×, drops it under `GRAIN_SIZE` so it never
   recruits the pool, makes the rep-pen kernel cheaper, and fixes the sampling semantics in §8.
   No engine patch required. Consider `PresencePenalty` separately — 1.5 over a retrieval
   context is likely wrong regardless.
2. **`OMP_NUM_THREADS=1`** in `Exl3LaunchEnvironmentSchema`. 0.72 cores at *default* blocktime —
   turboderp's one core, with the intended CUDA-sync spin left alone. Measured cost on the repro
   is ~0.2 ms/token (~1.3%), entirely the now-single-threaded memcpy. Honest statement of the
   fact that this process has no CPU math worth parallelizing.
3. **`KMP_BLOCKTIME=1`.** 1.45 cores. Works, but leaves the 12-thread fork/join per token and
   only suppresses the aftermath. Fallback if 1 and 2 both prove unacceptable.

Do **not** ship `KMP_BLOCKTIME=0` (+5% decode step latency, +31% prefill wall) or
`OMP_WAIT_POLICY=PASSIVE` + `OMP_NUM_THREADS=2` (−18% decode tok/s).

### Caveats before shipping

- The §6 repro isolates **decode**. Prefill's 2.39 cores come from different sites — the page
  copy at `job.py:1247` and `SeqTensor` growth `torch.cat` at `util/tensor.py:81` — where the
  copies are large enough that threading may genuinely pay. `OMP_NUM_THREADS=1` would
  single-thread those too. Untested.
- The earlier −18%/−23% arm was `OMP_NUM_THREADS=2` **plus** `KMP_BLOCKTIME=0` **plus**
  `PASSIVE`. `KMP_BLOCKTIME=0` is what cost the throughput. A thread cap alone at default
  blocktime has never been run in the real engine.
- All engine-level arms are n=1 with a ≥7% prefill-wall noise floor (§5).

## 10. Open items

- [ ] Real-engine A/B: `penalty_range=2048` vs current, and `OMP_NUM_THREADS=1` vs current.
      Prefer temperature 0 and ≥2 reps per arm to remove MTP-acceptance noise, and record
      prefill *and* decode separately.
- [ ] Confirm bounded `penalty_range` does not degrade output quality on repo-search prompts.
- [ ] File the two upstream issues with turboderp. 7.1 is a one-liner and affects every
      TabbyAPI user, not only deep-context ones; 7.2 is the real performance fix.
- [ ] If a launch-env var is adopted, note that
      [tests/model-preset-adapters.test.ts:46](../tests/model-preset-adapters.test.ts#L46) and
      [:80](../tests/model-preset-adapters.test.ts#L80) `deepEqual` the entire launch
      environment — both fixtures need the key or the suite fails. Rationale belongs in
      [docs/exl3-performance-tuning-2026-07-21.md](exl3-performance-tuning-2026-07-21.md)
      next to the `EXL3_QC_ATTN` note, not only in a code comment.

## 11. Repro scripts

In `%TEMP%\claude\c--Users-denys-Documents-GitHub-SiftKit\6097bc00-5c18-4d05-bc24-2b6d2ac4c47f\scratchpad\`:

| file | what it shows |
|---|---|
| `past_ids_real.py` | The decisive one — §6 table. Reproduces 11.24 cores from the memcpy + a 16 ms GPU wait. |
| `past_ids_copy.py` | Copy cost vs context depth, 12 threads vs 1. Locates the `GRAIN_SIZE` threshold. |
| `omp_spin.py` | Generic mechanism: one CPU op + GPU wait, across blocktime and pool-size arms. |
| `verify.cjs` | Independent re-parse of the five `sk_prof` logs. `node verify.cjs <logdir> [fromStep] [toStep]`. |
| `dlls.py` | Confirms `libiomp5md.dll` is loaded in the engine process. |

Run them with `C:\envs\rl310\Scripts\python.exe` so the arms match the engine's torch build.
