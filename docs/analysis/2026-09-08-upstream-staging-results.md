# Upstream staging validation — Windows complete, Linux blocked

Upstream reference: official `dev`, **a99c30994f6d9173e505254e81b0e5d784caa36e**.
The reference is frozen for this campaign. The older 1,500 tok/s control already contained
the retained staging patch; it was never the pristine upstream baseline.

Workload: the existing `eval/perf.py`, 410 CPU experts, 12 CPU threads, cache/max length
32768, **chunk 4096**, `-ngr`, full warmup and decode. Upstream defaults are retained:
native allocator, memops enabled, automatic stream threshold, four staging threads,
two 32 MiB GPU slots. Arena and model order are untouched. No per-machine/model tuning.

## Complete Windows observations

The first five pristine runs produced PP32k **981.76, 1017.54, 1009.16, 1009.40, 1024.15**;
median **1009.40**. The subsequent comparison interleaved five fresh controls with each
candidate, reversing order on alternate rounds. Every valid observation is included.

| Change | Five PP32k runs, tok/s | Median | Change versus interleaved upstream |
|---|---|---:|---:|
| Upstream control | 1011.24, 1021.02, 1018.39, 1019.08, 875.12 | 1018.39 | — |
| Retry bandwidth probe | 1011.98, 1026.33, 1020.22, 1007.44, 1008.99 | 1011.98 | -0.63% |
| Persistent staging pool | 910.33, 922.10, 1071.30, 1072.39, 1074.52 | 1071.30 | +5.20% |

Probe retry has no demonstrated standalone median gain. The pool remains provisional:
its PP improvement is inconsistent and it has a lower 8k decode median. Overlapping ranges
and this small sample do not establish a general causal decode effect.

| Decode context | Upstream median | Probe median | Pool median |
|---:|---:|---:|---:|
| 0 | 22.29 | 22.38 | 22.92 |
| 256 | 22.15 | 21.86 | 22.47 |
| 512 | 22.55 | 22.33 | 22.44 |
| 1024 | 22.26 | 22.75 | 22.88 |
| 2048 | 19.25 | 18.89 | 19.23 |
| 4096 | 22.71 | 22.77 | 22.54 |
| 8192 | 22.60 | 21.68 | 21.39 |
| 16384 | 22.64 | 22.12 | 22.51 |
| 32512 | 23.01 | 23.11 | 23.13 |

## Complete Windows piece-ring comparison

This second interleaved set has its own five pristine controls, with the same source and
workload as above. These controls are the reference for the following percentages.

| Configuration | Five PP32k runs, tok/s | Median | Versus upstream |
|---|---|---:|---:|
| Upstream | 988.15, 1003.86, 1023.48, 1009.62, 1001.22 | 1003.86 | — |
| Minimum ring + pool | 1194.21, 1009.44, 993.81, 985.52, 848.27 | 993.81 | -1.00% |
| Automatic ring + pool | 1245.98, 1271.42, 1233.43, 1024.19, 1248.54 | 1245.98 | +24.12% |
| Automatic ring, no pool | 908.91, 913.86, 910.61, 792.37, 827.74 | 908.91 | -9.46% |

Conditional removal comparisons: automatic sizing improves the median by **25.37%** over
the minimum ring, and the pool improves it by **37.09%** over the ring without a pool.
These percentages are not additive. The working candidate is the combination. Smaller
buffers also change the bandwidth probe's transfer size; this comparison does not isolate
cache residency from all other consequences of geometry.

| Decode context | Upstream median | Combined-ring median | Change |
|---:|---:|---:|---:|
| 0 | 22.79 | 23.59 | +3.51% |
| 256 | 22.45 | 21.92 | -2.36% |
| 512 | 22.05 | 23.20 | +5.22% |
| 1024 | 22.90 | 22.81 | -0.39% |
| 2048 | 19.33 | 18.43 | -4.66% |
| 4096 | 22.93 | 22.74 | -0.83% |
| 8192 | 22.12 | 22.04 | -0.36% |
| 16384 | 22.24 | 23.02 | +3.51% |
| 32512 | 23.38 | 24.14 | +3.25% |

The 2k decode difference remains a limitation; do not describe decode as uniformly faster
or unchanged. This bucket includes upstream's periodic placement maintenance: the raw perf
driver runs 100 forward calls per context, while `_split_swap_tick` forces an overdue sweep
at four times the default 128-tick interval. The earlier validation record also identified
the recurring 2k dip as this sweep. These new runs do not separately time its cost, so the
4.66% difference is not evidence of a general decode-kernel slowdown, nor can it be ignored.
The follow-up below tests probe retries inside the ring because its fourth run still had
a substantial PP slowdown.

## Probe retries inside the ring: five Windows pairs

Both branches use the identical native binary. This comparison's control is the ring parent,
not pristine upstream.

| Configuration | Five PP32k runs, tok/s | Median | Arithmetic mean |
|---|---|---:|---:|
| Ring parent | 1011.93, 1009.78, 1261.94, 1248.32, 1245.94 | 1245.94 | 1155.58 |
| Ring + retries | 1261.98, 1250.39, 1244.06, 1254.85, 1267.32 | 1254.85 | 1255.72 |

Median change is **+0.72%**, within the spread of normal runs. The retry variant avoided
the two slow parent observations in this sample: its observed range was 1244–1267 versus
1010–1262. Arithmetic-mean throughput improved 8.67%; total time for the five measured 32k
prefills fell from 143.35s to 130.48s (aggregate throughput +9.86%). These figures describe
the observed startup variation, not a demonstrated increase in the steady throughput ceiling.
Five trials do not establish a failure probability or guarantee elimination of slow starts.

Retry/parent decode medians by context: 0 22.52/22.74; 256 22.32/21.91; 512 22.95/22.25;
1024 22.76/22.54; 2048 19.33/18.98; 4096 22.35/22.43; 8192 22.17/22.45;
16384 23.09/22.19; 32512 22.64/23.08. No uniform decode improvement is demonstrated.

## Seven-item accounting

The historical seven items are not seven independent changes against this upstream.
Rows are ordered approximately from least to most invasive in the current implementation.

| Invasiveness | Historical change | Windows PP evidence | Windows decode evidence | Status |
|---|---|---|---|---|---|
| None | CUDA stream memops | Identical to upstream default | Identical code to baseline | No new patch |
| None | Preserve large GPU batches | Already upstream; retained unchanged | Identical code to baseline | No independent patch |
| None | Correct custom-pool spin budget | Custom pool was not introduced; existing wake policy reused | No separate change to measure | Superseded, no separate gain claimed |
| Low: one Python host file | Probe warmup/retries | -0.63% standalone median; +0.72% versus ring parent, with narrower observed spread | Mixed; no consistent gain | No demonstrated steady-speed gain; consistency evidence retained |
| Medium: one native file, +7/-8 production lines | Persistent workers | +5.20% standalone median with variation; +37.09% versus automatic ring without pool | Standalone 8k median -5.35%; mixed elsewhere | Contributes inside the combined PP candidate |
| Medium: Python startup and topology helper | Automatic cache sizing | +25.37% versus minimum ring; contributes to combined +24.12% versus upstream | Conditional 2k median -7.53% versus minimum ring, including maintenance | Dependency of combined candidate; no standalone upstream delta |
| Highest: host/native handoff and private ABI | Two pinned pieces | Minimum ring + pool: -1.00%; full combination: +24.12% versus upstream | Combined 2k -4.66%; other context medians -2.36% to +5.22% versus upstream | Retain as a combination only, pending Linux acceptance |

Linux throughput is unmeasured for every row. Conditional percentages use the stated
parent, not pristine upstream; do not add them together. A local PP candidate is not a
completed cross-platform performance acceptance decision.

## Linux status and correctness

Linux native builds and the selected correctness tests pass for upstream, probe, pool and
the combined ring. The ring passed 27 checks on each OS, including actual ordered GPU copies,
both synchronization modes, wraparound, partial pieces, mixed expert sizes, backpressure,
concurrent CPU compute and blocked shutdown.

**Zero complete new Linux model benchmarks.** The fresh upstream attempt failed during load
near layers 43–44 with a CUDA driver error before PP/decode. The prior investigation measured
host commit exhaustion at the same failure location; this fresh attempt did not measure its
failure-time peak. The prepared pagefile initial-size increase requires user authorization
and has not been applied. Native-test success does not establish Linux throughput.

Source/build identities, test details and active work are in
[the worklog](2026-09-07-upstream-staging-validation-worklog.md).
Candidate branches are experimental until their requested performance acceptance is complete.
No PRs or pushes have been made.

## Local branches and pending work

All refs below exist in both new checkouts. The old retained checkout and consumers are
untouched. Parent relationships are explicit; these are not seven independent upstream PRs.

| Branch | Commit | Parent | Current assessment |
|---|---|---|---|
| `baseline/upstream-dev-20260907` | `a99c309` | official dev | Pristine reference |
| `perf/staging-probe-retry` | `71bb832` | baseline | No standalone Windows median gain |
| `perf/staging-worker-pool` | `41e20f6` | baseline | Small standalone median gain with variation; contributes strongly inside the ring |
| `perf/staging-piece-ring` | `07009ad` | pool | Selected Windows PP combination: workers + pieces + sizing |
| `perf/staging-piece-ring-minimum` | `a4fb9f8` | ring | Removal control; rejected as a standalone Windows improvement |
| `perf/staging-piece-ring-no-pool` | `8d7b921` | ring | Removal control; rejected as a standalone Windows improvement |
| `perf/staging-piece-ring-probe` | `6be10e1` | ring | Consistency candidate, not an established steady-speed gain |

The checked-out Windows candidate excludes retries and both unsuccessful removal variants.
Experimental refs and scratch evidence are preserved because the required Linux comparisons
remain unfinished; final cross-platform selection and deletion of rejected refs are pending.
This is a checkpoint, not completion of the user's full request.

Fifty Windows runs are validated. Native builds/checks passed on both OSes. Final enclosing
typecheck/lint passed, as did strict runner checks and four parser tests. The independent
ring review found no introduced correctness blockers. It noted an inherited same-host reuse
after shutdown issue, tracked separately from this change.

[Resume handoff](2026-09-08-upstream-staging-handoff.md) records exact environment, pending
permission and reproduction steps. [Evidence archive](2026-09-08-upstream-staging-evidence.zip)
contains raw logs, all 50 result records, summaries, scripts and a verified delta bundle.
