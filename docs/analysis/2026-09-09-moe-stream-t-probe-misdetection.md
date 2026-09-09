# `EXL3_MOE_STREAM_T`: the bandwidth probe mis-detects the link

> **Superseded in part, 2026-09-09.** The headline below is correct: the probe mis-detects the
> link. The *Mechanism* and *What is confirmed, and what is not* sections were inferred from the
> code before `EXL3_MOE_STREAM_DEBUG=1` was captured, and the inference was wrong in two ways —
> the slow mode is `stream_t` **15** (probe reading **6.8 GB/s**, a Gen2 x16 plateau), never 9,
> and the quantity that drives the regression is tail **expert count**, not assignment share.
> Both sections have been rewritten in place. Root cause, evidence and the implemented fix are in
> [2026-09-09-moe-stream-t-probe-fix-handoff.md](2026-09-09-moe-stream-t-probe-fix-handoff.md).

Date: 2026-09-09. Status: defect confirmed; fix implemented and verified (see the fix handoff). Applies to the ported PR341
tree at `C:\AI\exl3\prod\src` (branch `deployment/pr341-zerocopy-on-dev`) and to PR341 upstream.

## Summary

PR341's streamed prefill picks its expert-streaming threshold from a one-shot PCIe bandwidth
probe run once per loaded model, in `MoeCpuHost._ensure_stream_state`. On this host the probe
does not reliably measure the link, and the resulting `stream_t` lands on one of two values.
The two values produce two discrete performance modes about 23% apart in prefill throughput.

Because the probe runs once per loaded model and the result is cached in `self.sstate`, a served
session that probes badly stays in the slow mode for the entire life of the loaded model. There
is no recovery short of an unload and reload.

## Evidence

Identical binary, identical args, GPU otherwise idle, five consecutive runs of `bench-prod.cmd`
(model `td_flash-next_4.05bpw_h6_ng6`, 415 CPU experts, chunk size 4096, `avx512-vbmi`,
12 threads):

| Run | Prefill @ 32768 | Decode @ 32512 |
|---|---:|---:|
| 1 | 1531.53 | 32.78 |
| 2 | 1886.76 | 33.07 |
| 3 | 1539.10 | 32.46 |
| 4 | 1886.14 | 32.61 |
| 5 | 1535.00 | 32.44 |

Two tight clusters, not a spread: slow 1535 +/- 4, fast 1886 +/- 0.4. Under 0.5% within each
mode, 22.9% between them. Decode is flat across both, as expected — decode never engages the
streamed path.

Pinning the threshold with `EXL3_MOE_STREAM_T=8`, which takes the `stream_t_explicit` branch and
skips the probe-derived scaling entirely:

| Run | Prefill @ 32768 | Decode @ 32512 |
|---|---:|---:|
| pinned 1 | 1883.91 | 32.24 |
| pinned 2 | 1882.94 | 32.94 |

Both land in the fast cluster, 0.05% apart. The two pinned runs were consecutive, while the
unpinned runs alternated mode on every single run, so the pin is overriding the probe rather
than having been lucky twice.

## Mechanism

*Rewritten 2026-09-09 from measurement; the original inference is in the correction table of the
fix handoff.*

`_ensure_stream_state` (`exllamav3/model/moe_cpu_host.py`) warms the link for a 0.25 s wall-clock
budget, then takes the best of 8 event-timed 16 MiB pinned-to-device copies, and scales:

```python
st["stream_t"] = max(self.stream_t, int(round(self.stream_t * (25.0 / max(bw, 0.5)) ** 0.5)))
```

The GPU idles at **PCIe Gen1** while the CPU worker rehomes 415 x 48 expert blocks into the
shared arena — a long, entirely GPU-free phase. The link then retrains from Gen1 to Gen4 as a
**single discrete step at ~160 ms**, not as a ramp, so the 0.25 s budget clears the event it is
racing by only ~1.5x. When the step lands late the probe measures a partially retrained link.
Measured over ten runs, the probe read **6.8 GB/s** — a Gen2 x16 plateau — in **3 of 8** loads,
against **26.5 GB/s** warm. That the retrain passes through intermediate generations which hold
long enough to look settled is why the failure reads 6.8 and not the 3.3 GB/s Gen1 floor.

The staircase maps 6.8 GB/s to **`stream_t 15`**, and does so correctly: this is a wrong reading,
not a borderline one. `stream_t 15` shrinks the streamed set 254 -> 219 experts and grows the CPU
tail **161 -> 196 experts per layer**.

The regression is driven by tail **expert count**, not by assignment share. Per-expert assignment
counts in a 4096-token chunk do not cluster near the threshold — the mean is ~80, and at
`stream_t 8` **99.17%** of assignments already stream against **98.05%** at 15. The population
that moves is small in assignments but significant in expert count, and the tail pays a full DRAM
weight load per expert regardless of how few tokens that expert serves.

The result is cached in `self.sstate` for the life of the loaded model, with no recovery short of
an unload and reload.

The probe's own comment states the hazard it is trying to defeat:

> An idle PCIe link sits in a low power state and only retrains to full width/speed under
> sustained traffic (hundreds of ms on Windows), so warm it for a wall-clock budget and take the
> best of several samples.

The mitigation is correctly motivated. The defect is that *any* fixed wall-clock budget is a coin
flip against a step function whose latency is not bounded by anything the code controls.

## What is confirmed, and what is not

*Rewritten 2026-09-09. Everything previously listed as inferred has since been measured, and one
inference was refuted.*

Confirmed by measurement, over ten runs with `EXL3_MOE_STREAM_DEBUG=1`:

- The prefill result is bimodal with two tight clusters, and the mode alternates run to run.
- The slow mode is `stream_t` **15**, from a probe reading **6.8 GB/s**. No run ever produced the
  `stream_t 9` inferred here originally.
- Pinning `EXL3_MOE_STREAM_T=8` reproduces the fast cluster consistently, *including on loads
  whose probe read 6.8 GB/s*. Pinning 15 reproduces the slow cluster on a warm 26.5 GB/s link, to
  three digits. `stream_t` alone determines the mode.
- Decode is unaffected in either mode (31.4 - 33.3 tok/s across all ten runs); decode never
  engages the streamed path.

Refuted:

- That the probe might be reading a genuinely degraded link. With the threshold pinned to 8, a
  6.8 GB/s probe still lands in the fast cluster, so the link retrains as soon as real prefill
  traffic starts. The reading is a transient measurement artifact.

## Interim mitigation

Set `EXL3_MOE_STREAM_T=8` in the launch environment. This is a documented upstream knob, and 8
is the base default, so pinning it disables a scaling heuristic that on this host only ever
mis-fires — the link is a CPU-direct x16 gen4 to a 4090, comfortably in the regime the scaling
is meant to leave alone.

This is a deployment setting, not a source change, and it is not part of the port.

## The fix

Implemented and verified. See
[2026-09-09-moe-stream-t-probe-fix-handoff.md](2026-09-09-moe-stream-t-probe-fix-handoff.md).

The defect is in the detection, not in the scaling law: 6.8 GB/s is not a borderline reading that
a gentler staircase would rescue, it is a wrong reading that the staircase maps correctly. The
fix replaces the fixed warm-up plus best-of-8 with a probe that times every copy and keeps the
running best until the measurement settles, with a floor on total observation time so an
intermediate plateau cannot end it early. A genuinely slow link keeps its low reading and its
high `stream_t`, which is what the calibration wants.

Verified on upstream `dev` (`fix/moe-stream-probe-convergence`, `a69923b`): 3 of 8 loads probed
cold before, 0 of 8 after.