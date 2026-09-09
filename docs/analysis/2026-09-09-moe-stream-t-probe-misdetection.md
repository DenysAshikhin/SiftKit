# `EXL3_MOE_STREAM_T`: the bandwidth probe mis-detects the link

Date: 2026-09-09. Status: defect confirmed, fix not yet designed. Applies to the ported PR341
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

`_ensure_stream_state` (`exllamav3/model/moe_cpu_host.py`) warms the link for a 0.25 s wall-clock
budget, then takes the best of 8 event-timed 16 MiB pinned-to-device copies, and scales:

```python
st["stream_t"] = max(self.stream_t, int(round(self.stream_t * (25.0 / max(bw, 0.5)) ** 0.5)))
```

With the default `stream_t = 8`, the first step of that staircase sits at **bw = 22.1 GB/s**:
above it the threshold stays 8, below it the threshold becomes 9. So a probe that lands a little
low moves the streaming threshold by exactly one assignment.

That one step is not a small effect, because the per-expert assignment counts in a 4096-token
chunk cluster near the threshold. Moving it from 8 to 9 demotes a large population of experts
from the streamed path to the CPU tail at once. The observed 23% gap is a cliff, not a gradient.

The probe's own comment states the hazard it is trying to defeat:

> An idle PCIe link sits in a low power state and only retrains to full width/speed under
> sustained traffic (hundreds of ms on Windows), so warm it for a wall-clock budget and take the
> best of several samples.

The 0.25 s warm-up plus best-of-8 is evidently not always enough to get the link retrained under
WDDM. The mitigation is present and correctly motivated; it is just not strong enough here.

## What is confirmed, and what is not

Confirmed by measurement:

- The prefill result is bimodal with two tight clusters, and the mode alternates run to run.
- Pinning `EXL3_MOE_STREAM_T=8` reproduces the fast cluster consistently.
- Decode is unaffected in either mode.

Not yet confirmed — inferred from the code and the arithmetic above:

- That the slow mode is specifically `stream_t = 9`, and that the probe is reading below
  22.1 GB/s when it happens. `EXL3_MOE_STREAM_DEBUG=1` prints the measured bandwidth and the
  chosen `stream_t` on one line per device and would settle both directly. It was off for every
  run above, so no probe value was captured.

Any fix should start by capturing that line in both modes rather than trusting the inference.

## Interim mitigation

Set `EXL3_MOE_STREAM_T=8` in the launch environment. This is a documented upstream knob, and 8
is the base default, so pinning it disables a scaling heuristic that on this host only ever
mis-fires — the link is a CPU-direct x16 gen4 to a 4090, comfortably in the regime the scaling
is meant to leave alone.

This is a deployment setting, not a source change, and it is not part of the port.

## Direction for the fix

To be designed. The defect is in the detection, not in the scaling law: the calibration comment
records that 8 was measured best on both gen5 x16 and gen5 x8, and 16 on gen4 x4, so the
staircase itself is sound where the bandwidth reading is trustworthy. Candidates worth weighing
when the fix is planned — a longer or convergence-based warm-up instead of a fixed 0.25 s
budget, rejecting a probe whose samples have not stabilised, deriving the link's theoretical
ceiling from the device's reported PCIe generation and width and treating the probe as a sanity
check against it, or moving the decision off a measured absolute bandwidth altogether.

The fix belongs in the ported tree and should be offered upstream to PR341, which is still an
open draft and carries the same probe unchanged.
