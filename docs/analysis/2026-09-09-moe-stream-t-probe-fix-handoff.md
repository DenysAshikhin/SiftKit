# Handoff: fix the `EXL3_MOE_STREAM_T` bandwidth probe and offer it upstream

Date: 2026-09-09. Status: root cause confirmed, **fix implemented and verified on upstream `dev`**
(branch `fix/moe-stream-probe-convergence`, commit `a69923b`, in `C:\AI\exl3\baseline\src`).
Remaining: **fold it into PR341 and open the PR there**, not against `dev` — see *Why this
matters on PR341 and barely registers on upstream `dev`*, then tasks 6-10.

Supersedes the *Mechanism* and *What is confirmed, and what is not* sections of
[2026-09-09-moe-stream-t-probe-misdetection.md](2026-09-09-moe-stream-t-probe-misdetection.md).
That document's headline (the probe mis-detects the link) is correct. Its inferred mechanism is
not, and the corrections are listed below.

## Root cause (confirmed)

The GPU idles at **PCIe Gen1** while the CPU worker rehomes 415 x 48 expert blocks into the
shared arena — a long, entirely GPU-free phase. The first prefill then calls
`MoeCpuHost._ensure_stream_state`, whose probe warms the link for a fixed 0.25 s and takes
best-of-8. The link retrains from Gen1 to Gen4 as a **single discrete step at ~160 ms**, so a
0.25 s budget clears the event it is racing by only ~1.5x. When the step lands late the probe
measures a partially retrained link, and the reading is cached in `self.sstate` for the life of
the loaded model with no recovery short of unload/reload.

Chain, each link measured:

1. Probe reads **6.8 GB/s** (Gen2 x16) instead of **26.5 GB/s** (Gen4 x16) — in **3 of 8** runs.
2. The staircase maps 6.8 to **`stream_t 15`**.
3. `stream_t 15` shrinks the streamed set 254 -> 219 experts and grows the CPU tail
   **161 -> 196 experts per layer**.
4. The CPU tail becomes the critical path: **-18.5%** prefill at 32768 (1881 -> 1534 tok/s).

## Corrections to the prior analysis

| Prior claim | Measured |
|---|---|
| Slow mode is `stream_t 9`, probe reading just under 22.1 GB/s | `stream_t` **15**, probe reading **6.8 GB/s**. No run ever produced 9. |
| "Per-expert assignment counts in a 4096-token chunk cluster near the threshold" | They do not. Mean count is ~80 (top-10 of 512 experts). At `stream_t 8`, **99.17%** of assignments already stream; at 15, **98.05%**. Assignment share is the wrong metric. |
| "Moving it from 8 to 9 demotes a large population of experts" | The population that moves is small in *assignments* but significant in *expert count*. The tail pays a full DRAM weight load per expert regardless of how few tokens it serves, so tail **expert count** (161 -> 196) is the quantity that drives the regression. |
| Two tight clusters ~23% apart | Confirmed, and the slow cluster is reproduced exactly by pinning the threshold: c1/c2 at 1534.60/1535.14 vs the original 1535 +/- 4. |
| Probe may be reading a genuinely degraded link | Refuted. See b3/b4 below. |

## Evidence

Ten runs of the 32k `perf.py` sweep, model `td_flash-next_4.05bpw_h6_ng6`, 415 CPU experts,
chunk 4096, `avx512-vbmi`, 12 threads, GPU otherwise idle, `EXL3_MOE_STREAM_DEBUG=1` throughout.
Logs: `C:\AI\exl3\logs\2026-09-09-migration\bench-dbg-{a1..a4,b1..b4,c1,c2}.log`.

| run | pinned | probe GB/s | `stream_t` | streamed/415 | tail | asg% | pf@4096 | pf@32768 | dec@32512 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| a1 | — | 26.6 | 8 | 254 | 161 | 99.17 | 1977.21 | 1882.86 | 31.98 |
| a2 | — | 26.5 | 8 | 254 | 161 | 99.17 | 1782.87 | 1826.15 | 33.30 |
| a3 | — | **6.8** | **15** | 219 | 196 | 98.05 | 1576.28 | **1513.03** | 32.72 |
| a4 | — | 26.5 | 8 | 254 | 161 | 99.17 | 1950.45 | 1881.66 | 32.31 |
| b1 | `T=8` | 26.5 | 8 | 254 | 161 | 99.17 | 1986.42 | 1866.89 | 32.91 |
| b2 | `T=8` | 26.5 | 8 | 254 | 161 | 99.17 | 1957.75 | 1869.53 | 32.91 |
| b3 | `T=8` | **6.8** | 8 | 254 | 161 | 99.17 | 1969.62 | **1853.99** | 31.42 |
| b4 | `T=8` | **6.8** | 8 | 254 | 161 | 99.17 | 1944.20 | 1873.05 | 33.06 |
| c1 | `T=15` | 26.6 | 15 | 219 | 196 | 98.05 | 1607.49 | **1534.60** | 33.05 |
| c2 | `T=15` | 26.5 | 15 | 219 | 196 | 98.05 | 1613.79 | **1535.14** | 33.34 |

The 2x2 is complete and every cell is populated:

| | `stream_t 8` | `stream_t 15` |
|---|---|---|
| **warm probe (26.5)** | fast — a1, a2, a4, b1, b2 | **slow — c1, c2** |
| **cold probe (6.8)** | **fast — b3, b4** | slow — a3 |

Two readings settle causality:

- **b3/b4**: cold probe, threshold pinned to 8, both in the fast cluster. The link therefore
  retrains as soon as real prefill traffic starts; the 6.8 GB/s reading is a transient
  measurement artifact, not a degraded link. This refutes the alternative explanation.
- **c1/c2**: warm probe on a demonstrably healthy 26.5 GB/s link, threshold forced to 15, both
  in the slow cluster to three digits. `stream_t` alone determines the mode.

Decode is flat across all ten runs (31.42 - 33.34), as expected: decode never engages the
streamed path.

### Retrain curve

`C:\AI\exl3\staging\2026-09-09-migration\probe-repro.py --trace`, after 45 s idle:

```
t =   0.0 ms   3.31 GB/s     <- Gen1 x16, matches nvidia-smi pcie.link.gen.current = 1 when idle
t = 150.8 ms   3.38 GB/s
t = 166.9 ms  26.56 GB/s     <- single step straight to Gen4 x16
t = 289.6 ms  26.58 GB/s     <- flat thereafter
```

A step function, not a ramp. This is why the outcome is bimodal, and why any *fixed* wall-clock
budget is a coin flip when the step lands near it.

## Fix design

Replace the fixed warm-up + best-of-8 with a probe that times **every** copy, keeps the running
best over a window long enough to contain the retrain, and only then allows a settle test to end
it. As implemented in `a69923b`:

```python
floor = 2.0     # observe at least this long: ~12x the observed retrain latency
settle = 0.5    # after the floor, best unimproved this long -> at the ceiling
cap = 5.0       # bound for a link that never settles
...
if sample > bw * 1.02:   # 2%: ignore sample noise, catch a link generation
    t_improved = now
bw = max(bw, sample)
if now - t0 >= floor and now - t_improved >= settle:
    break
if now - t0 >= cap:
    print(" !! CPU MoE: pinned->device probe ... did not settle ...")
    break
```

**The floor is load-bearing, and a settle test alone is not sufficient.** My first version used
settle-only (floor 0.25 s), and `probe-convergence-sim.py` falsified it immediately: a link
flat at Gen1 for longer than the settle window is indistinguishable from a genuinely slow link,
so the probe stops *before* the retrain and returns 3.3 GB/s -> `stream_t 22`. That is not
hypothetical — the observed real failure read 6.8 GB/s, a **Gen2 plateau**, which means the
retrain passes through intermediate generations that hold long enough to look settled. Only a
floor on total observation time defeats that.

Cost is ~2 s once per loaded model against 250 ms today — negligible beside model load.

**Do not change the scaling law.** 6.8 GB/s is not a borderline reading that a gentler
staircase would rescue; it is a wrong reading that the staircase maps correctly. A genuinely
slow link (real Gen4 x4 at 6.7 GB/s) plateaus on its first samples, settles at the floor, and
keeps its low reading and its high `stream_t` — confirmed in the simulation. Note the formula
gives **15** there, while the upstream calibration comment claims 16 was measured best: a
pre-existing inconsistency between comment and code, not introduced by this change.

The **warning when the cap is hit while the best is still improving** is included: the
measurement is then known-bad, and silently caching it is what makes this defect invisible
today. A warning, not an exception — raising would break a host that is legitimately slow. It
prints to stdout like the rest of this module (`sys` is not imported in `dev`'s copy, and adding
the import would widen the diff past `_ensure_stream_state`).

### Known limitation, asserted rather than glossed

A retrain slower than `floor + settle` is still missed, **and missed silently** — the probe
settles at the floor and never reaches the cap that warns. No such retrain has been observed
(measured ~160 ms, against a 2 s floor). This case is pinned as an explicit expectation in
`probe-convergence-sim.py` so it stays visible. Removing it entirely needs the structural fix
below.

### Not in scope, but worth recording

`stream_t` is derived once from one instant and cached in `self.sstate` for the life of the
loaded model. Even with a correct probe, a single bad reading is permanent. The structural fix
is to re-derive it after the first real prefill chunk, when traffic guarantees a warm link.
That is a larger change than repairing the probe and was explicitly deferred.

## How upstream `dev` differs from the port

`origin/dev` at `a352583` has its own copy of the probe. The differences are cosmetic to the
defect — the fixed 0.25 s warm budget and best-of-8 are identical, so **`dev` is exposed exactly
as the port is**.

```python
st["vram_slots"][0][:probe // 2].copy_(self.wviews[0][:probe // 2], non_blocking = True)
...
bw = max(bw, probe / (ev0.elapsed_time(ev1) * 1e-3) / 1e9)   # GB/s
```

The `probe // 2` slice looks like it measures half the bytes it divides by, but it does not, and
this was checked rather than assumed: on `dev` both `vram_slots` and `wviews` are **`int16`**
tensors sized `wslot_size // 2` *elements*, so `[:probe // 2]` is `probe // 2` elements =
`probe` bytes. The arithmetic is correct and matches PR341, which uses `uint8` buffers where the
same slice is expressed directly in bytes. Do not "fix" this.

The real differences:

| | `dev` | port / PR341 |
|---|---|---|
| buffers | `int16`, element-sliced | `uint8`, byte-sliced |
| DMA source | pinned staging `wviews[0]` | arena `arena[0]` (zero-copy) |
| DMA destination | `vram_slots[0]` | `raw_slots[0]` |
| warm loop | `for _ in range(256)` with a 0.25 s `break` | `while elapsed < 0.25` |

`dev`'s 256-iteration cap does not bind: at Gen1 each 16 MiB copy takes ~4.8 ms, so the 0.25 s
timeout always fires first. Same exposure, same expected failure mode, same expected
`stream_t 15` on a cold reading.

## Status: what has been done

Tasks 1-5 below are complete. Branch `fix/moe-stream-probe-convergence` off `origin/dev`
`a352583`, commit `a69923b`, one file, 37 insertions / 12 deletions, entirely inside
`_ensure_stream_state`.

### Result on upstream `dev`, 8 loads before and after

| | cold probes (6.8 GB/s) | `stream_t 15` | pf@32768 |
|---|---:|---:|---|
| before, stock `dev` | **3 / 8** | 3 | cold 1036.00 / 1047.42 / 1072.71; warm 1063.18 - 1191.49 |
| after, convergence probe | **0 / 8** | 0 | 1135.30 - 1199.83, all `stream_t 8` |

Every after-run probed 26.7 GB/s. No run emitted the non-convergence warning. Under the observed
3-in-8 cold rate, drawing 0 of 8 by chance is p ~ 0.023.

Full tables: `analyze-dev-sweep.sh before` and `analyze-dev-sweep.sh after`.

### Environment state left behind — read before reusing `baseline`

`C:\AI\exl3\baseline\venv` **is no longer a stock upstream `dev` install.** Its
`site-packages/exllamav3/model/moe_cpu_host.py` was overwritten with the patched file so the
after-sweep would exercise it (the venv is a wheel install, so editing `baseline\src` alone has
no effect). Source and installed copy are currently identical, md5 `0e36a03b…`.

This matters because `baseline` is the environment the port handoff treats as the pure-upstream
reference. To restore stock behaviour:

```
git -C C:\AI\exl3\baseline\src stash        # or check out origin/dev
copy exllamav3\model\moe_cpu_host.py -> venv\Lib\site-packages\exllamav3\model\
```

`C:\AI\exl3\prod\src` was **not** touched: it is byte-for-byte as this work found it.

### Two corrections to the numbers this document was written with

1. **The `dev` sweep has a cache confound.** Its warm-probe runs trend upward across the sweep
   (1063 -> 1141 -> 1165 -> 1187 -> 1191) because the first runs also had a cold OS file cache
   for the 30 GB model. Run order is therefore confounded with probe outcome. Run 8 breaks it: a
   cold probe with a fully warm cache gave 1072.71 against neighbours at 1187/1191, so the
   defect costs **~10% on `dev`**, not the ~2% the third run alone suggested. Size any future
   sweep to separate these, or pin the cache state.
2. **The `dev` baseline in the port handoff is suspect.** That document records upstream `dev` at
   **1052.06** tok/s @32768 as the baseline for its "-37.4%" regression claim. The three
   cold-probe runs here average **1052.0**. That is a coincidence of means on n = 3, not proof,
   but it is close enough that the baseline was plausibly measured in the degraded mode, which
   would overstate the port's advantage. **Re-measure both sides with `EXL3_MOE_STREAM_T` pinned
   before quoting that figure again.**

### Why this matters on PR341 and barely registers on upstream `dev`

**This is the central point for the PR, and a reviewer testing only on `dev` will not see it.**

Same host, same link, same routing: the probe reads 26.5-26.7 GB/s on both trees. What differs
is how much of that link the streamed path can actually use.

Upstream `dev` stages every streamed expert through a pinned host staging ring, so each streamed
byte costs a DRAM write plus a DRAM read before it reaches the link. The staging copy, not the
link, is the limiter — `dev` cannot saturate PCIe no matter how many experts it streams. PR341
replaces that with a DMA straight out of the page-locked arena, so the only DRAM traffic per
streamed byte is the DMA read and the link becomes the limiter. That is why PR341 is much faster
in absolute terms, and it is also why the threshold suddenly matters.

Measured, 32768-token prefill, 8 chunks of 4096:

| | upstream `dev` | PR341 port |
|---|---:|---:|
| good `stream_t 8` | 1179.10 tok/s (mean of 8) | 1864.88 tok/s (mean of 7) |
| bad `stream_t 15` | 1052.04 tok/s (mean of 3) | 1527.59 tok/s (mean of 3) |
| relative loss | **-10.8%** | **-18.1%** |
| time for 32k | 27.79 s -> 31.15 s | 17.57 s -> 21.45 s |
| **added cost per 4096 chunk** | **0.42 s** | **0.49 s** |
| baseline time per chunk | 3.47 s | 2.20 s |

The added cost is **the same work in both trees** — 0.42 s against 0.49 s, within ~15%. It is
the same ~35 experts per layer being demoted from the GPU-streamed path to the CPU tail, and the
CPU worker is identical. What changes is the denominator: PR341's chunk is 37% shorter, so an
identical absolute penalty becomes a much larger fraction of runtime.

So the defect is not "worse" under PR341 — it is equally bad, and PR341 simply removes the
staging bottleneck that was masking it. On `dev` a 0.42 s tail penalty hides inside a transport
that was already leaving the link idle; on PR341 there is nothing left to hide behind.

Two consequences for the PR:

- Justify it on PR341's numbers, not `dev`'s. On `dev` alone the fix looks like a ~10%
  edge case; the honest framing is that it is a prerequisite for PR341 delivering its own gains
  reliably, since 3 loads in 8 silently lose a third of them.
- Do not let a reviewer benchmark the probe fix on stock `dev` and conclude it is marginal.

## Tasks

Work on a branch off **upstream `dev`**, not in the deployment port. Do not commit to
`deployment/pr341-zerocopy-on-dev`.

1. ~~**Branch.**~~ DONE. `C:\AI\exl3\baseline\src` is a clean checkout of `origin/dev` at `a352583` with
   its own Python 3.14.7 / Torch 2.14 venv at `C:\AI\exl3\baseline\venv`. Branch from there,
   e.g. `fix/moe-stream-probe-convergence`. Keep the diff to `_ensure_stream_state` only — this
   must stay a small, targeted, reviewable PR.
2. ~~**Record "before" on `dev`.**~~ DONE, 8 runs, 3 cold. With `EXL3_MOE_STREAM_DEBUG=1`, run the benchmark enough times
   to capture both outcomes and record the `stream_t` distribution. Given the 3-in-8 cold rate
   observed, plan **8-10 runs**. Expect the same 26.5 / 6.8 GB/s split and the same
   `stream_t 8` / `15` outcomes as the port. If no cold reading appears, say so rather than
   reporting a clean result — the failure is timing dependent and absence of it in a short sweep
   is not evidence of absence.
3. ~~**Implement**~~ DONE. The convergence probe on that branch.
4. ~~**Record "after".**~~ DONE, 8 runs, 0 cold. Same sweep size, same command, same environment. The acceptance signal is
   that no run selects a `stream_t` above the warm-link value.
5. ~~**Verify the slow-link property.**~~ DONE, simulated: Confirm a plateaued low reading still converges quickly
   and still yields the calibrated high `stream_t`. If no Gen4 x4 link is available, simulate a
   plateaued sample sequence rather than skipping this check, and label it as simulated.
   `probe-convergence-sim.py` covers 9 cases including a genuine gen4 x4 link, which keeps its
   low reading and its high `stream_t` rather than being "rescued" to 8. Note that the formula
   yields `stream_t 15` at 6.7 GB/s while the upstream calibration comment claims 16 was best --
   a pre-existing inconsistency between the comment and the code, not introduced here.
6. **TODO. Fold the fix into PR341** — this is where it belongs, per the section *Why this
   matters on PR341 and barely registers on upstream `dev`*. The `dev` branch `a69923b` is the
   reference implementation and its verification data; PR341 is the target.

   The probe body in `C:\AI\exl3\prod\src` is **byte-identical to the `pr341` ref**, so one
   patch serves both. Note the `pr341` ref exists in `C:\AI\exl3\prod\src` but **not** in
   `baseline\src`, which only carries `dev` refs.

   Translating `a69923b` to PR341 is mechanical — same loop, same three constants, only the
   copy line differs:

   | | `dev` | PR341 |
   |---|---|---|
   | source | `self.wviews[0][:probe // 2]` (int16 elements) | `src = self.arena[0][:probe]` (uint8 bytes) |
   | destination | `st["vram_slots"][0][:probe // 2]` | `st["raw_slots"][0][:probe]` |
   | `import time` | inside the `with` block | already above `probe = ...` |

   Keep the diff inside `_ensure_stream_state`. Do not add `import sys`: PR341's module does not
   import it either, and the warning prints to stdout like the rest of the module.

7. **TODO. Verify on the port.** Run the 8-run sweep against
   `C:\AI\exl3\prod\src` / `prodenv` exactly as the `dev` sweeps were run
   (`bench-prod-dbg.cmd`, unpinned, `EXL3_MOE_STREAM_DEBUG=1`). This is the verification that
   actually matters, because the port is where the loss is -18.1%. Acceptance: 0 of 8 loads
   select `stream_t 15`, and pf@32768 stays in 1826-1883 with no run near 1513-1535.

   `prodenv` is a wheel install, so editing `prod\src` alone has no effect — copy the patched
   `moe_cpu_host.py` into `prodenv\Lib\site-packages\exllamav3\model\` as was done for
   `baseline`. Pure-Python change; no native rebuild needed.

8. **TODO. Open the PR against PR341**, not against `dev`. PR341 is still an open draft. Lead
   with the PR341 numbers and the masking explanation above; a reviewer who benchmarks the probe
   fix on stock `dev` will measure ~10% and wrongly conclude it is marginal.

9. **TODO. Fold the corrections** in this document back into
   `2026-09-09-moe-stream-t-probe-misdetection.md`, whose *Mechanism* section is now known
   wrong. Do not leave it standing unqualified.

10. **TODO. Re-measure the port-vs-`dev` baseline** with `EXL3_MOE_STREAM_T` pinned before the
    "-37.4%" figure in the port handoff is quoted again. See the correction note above: the
    recorded `dev` baseline of 1052.06 coincides with this session's cold-probe mean of 1052.04.

## Acceptance criteria

- No run in the "after" sweep selects a `stream_t` above the warm-link value.
- Prefill @32768 stays in the fast cluster (~1826-1883) across the whole sweep, with no run in
  the ~1513-1535 slow cluster.
- Decode @32512 unchanged (~31.4-33.3).
- A plateaued slow link still yields the calibrated high `stream_t`.
- The `dev` diff touches `_ensure_stream_state` only.

## Reproduction assets

Scripts, `C:\AI\exl3\staging\2026-09-09-migration\`:

| File | Purpose |
|---|---|
| `bench-prod-dbg.cmd` | benchmark, `EXL3_MOE_STREAM_DEBUG=1`, threshold unpinned |
| `bench-prod-dbg-st8.cmd` | as above, `EXL3_MOE_STREAM_T=8` |
| `bench-prod-dbg-st15.cmd` | as above, `EXL3_MOE_STREAM_T=15` |
| `run-probe-evidence.sh` | the A (4 unpinned) then B (4 pinned-8) sweep |
| `run-st15.sh` | the C block (2 pinned-15) |
| `analyze-probe-evidence.sh` | extracts the evidence table from the logs |
| `probe-repro.py` | standalone probe: `--trace` for the retrain curve, default mode for paired current-vs-converged from one cold start |
| `probe-convergence-sim.py` | simulated check of the stop rule over 9 link behaviours, incl. a genuine gen4 x4 and the known-limitation case |
| `bench-baseline-dbg.cmd` | upstream `dev` benchmark with `EXL3_MOE_STREAM_DEBUG=1` |
| `run-baseline-before.sh` / `run-baseline-after.sh` | the 8-run `dev` before/after sweeps |
| `analyze-dev-sweep.sh` | extracts the `dev` before/after tables (`... before` / `... after`) |

Logs are retained under `C:\AI\exl3\logs\2026-09-09-migration\bench-dbg-*.log`.

**Caveat on iteration speed.** `probe-repro.py` reproduces the Gen1 idle state and the retrain
step but **does not reproduce the misdetection**: 8 consecutive cold starts all read 26.5 GB/s
and selected `stream_t 8` under the current algorithm. The failure appears to need the real load
context (~30 GB registered shared arena, worker threads, full VRAM residency). There is no cheap
iteration loop — verification means real 2.5-minute benchmark runs, which is why the sweeps above
are sized at 8-10.

## Interim mitigation, unchanged

`EXL3_MOE_STREAM_T=8` in the launch environment. Deployment setting, not a source change, not
part of the port.
