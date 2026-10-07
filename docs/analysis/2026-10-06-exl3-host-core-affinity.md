# EXL3 CPU-MoE host-core affinity: before/after (2026-10-06)

Plan: `docs/superpowers/plans/2026-10-06-exl3-host-core-affinity.md`.

## Build

| Item | Value |
|---|---|
| Source | `C:\AI\exl3\dev-20261006\src`, branch `production-20261006` @ `5b88e4a` = `origin/dev` `d68e8fb` + PR #389 (WDDM, `58211c3`) + host affinity (`28e84f9`, branch `feat/moe-cpu-host-affinity`) |
| Wheel | `C:\AI\exl3\packages\prod\5b88e4a\exllamav3-1.5.4-cp314-cp314-win_amd64.whl`, sha256 `3525641b388f8a0fc9696afdbf334f3eeaf794a83326492db56eba0b69057de7` |
| Runtime | installed into `venv-runtime` (rollback wheel: `packages\prod\9f2f6f8`) |

Every arm used the same wheel and Tabby config (Flash Next, 408/512 experts on CPU, pinned arena); only `EXL3_MOE_HOST_CORES` and the draft mode changed.

## What the change does at runtime (verified per arm)

| | `EXL3_MOE_HOST_CORES=0` | `EXL3_MOE_HOST_CORES=1` (default) |
|---|---|---|
| Log | `CPU MoE worker started: 48 layers, avx512-vbmi, 12 threads` | `... 11 threads` + `CPU MoE host affinity: host on LPs [22, 23]` |
| Tabby `main.py` mask | `0xFFFFFF` | `0xC00000` |
| Worker process mask(s) | `0xFFFFFF` | `0xFFFFFF` (main and MTP workers) |

With MTP the 1-layer MTP worker starts before the 48-layer main worker; the placement is computed once (same 11 threads) and both workers keep the full mask.

## Results (decode T/s, warmup excluded)

Probes: code-explain think-off (500), code-explain think-on (700), code-write think-off (500), prose think-off (500), 6k-token code think-on (700). Order: A/B/A for each draft mode, then one extra B arm each.

| Arm | CPU% before | Free commit MiB | VRAM | code-expl off | code-expl on | code-write | prose | 6k code | mean | min | max | MTP acc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| no-MTP h0 A | 9 / 7 / 5 | 75804 | 20812 | 19.07 | 15.32 | 22.53 | 19.63 | 17.94 | 18.90 | 15.32 | 22.53 | – |
| no-MTP h1 B | 16 / 15 / 18 | 75275 | 20812 | 20.57 | 19.66 | 27.25 | 26.17 | 24.79 | 23.69 | 19.66 | 27.25 | – |
| no-MTP h0 A2 | 15 / 10 / 13 | 76490 | 20812 | 21.83 | 22.77 | 18.99 | 17.79 | 21.19 | 20.51 | 17.79 | 22.77 | – |
| no-MTP h1 B2 | 10 / 7 / 14 | 75050 | 20812 | 14.76 | 22.82 | 25.71 | 24.01 | 21.37 | 21.73 | 14.76 | 25.71 | – |
| MTP h0 A | 9 / 9 / 16 | 76265 | 21494 | 23.03 | 22.44 | 25.92 | 17.20 | 18.83 | 21.48 | 17.20 | 25.92 | 78% |
| MTP h1 B | 29 / 15 / 25 | 76445 | 21494 | 28.65 | 22.64 | 33.26 | 25.80 | 16.33 | 25.34 | 16.33 | 33.26 | 79% |
| MTP h0 A2 | 11 / 8 / 7 | 76579 | 21494 | 19.00 | 14.89 | 19.50 | 16.25 | 18.95 | 17.72 | 14.89 | 19.50 | 80% |
| MTP h1 B2 | 3 / 7 / 18 | 74515 | 21494 | 21.20 | 26.81 | 29.11 | 19.27 | 24.47 | 24.17 | 19.27 | 29.11 | 81% |

| Group (n = 10 probes) | mean | median | stdev | min | max |
|---|---|---|---|---|---|
| no-MTP, host_cores 0 | 19.71 | 19.35 | 2.38 | 15.32 | 22.77 |
| no-MTP, host_cores 1 | **22.71** (+15%) | 23.41 | 3.75 | 14.76 | 27.25 |
| MTP=1, host_cores 0 | 19.60 | 18.98 | 3.34 | 14.89 | 25.92 |
| MTP=1, host_cores 1 | **24.75** (+26%) | 25.13 | 5.06 | 16.33 | 33.26 |

## Interpretation

Reserving a core for the host raises mean decode by 15% without MTP and 26% with MTP=1 on these probes. MTP only pays off once the host is isolated: with `host_cores=0` MTP and no-MTP tie (19.6 vs 19.7) despite ~80% acceptance; with `host_cores=1` MTP is 9% ahead of no-MTP. The spread does not collapse the way the morning's manual-affinity runs did (C2: 28–35 T/s on short probes). Two likely reasons: these probes carry long code prompts with thinking on (more attention work per token, lower ceiling), and other desktop processes (5–29% background CPU during the runs) are just as unpinned as the host was and still preempt pinned workers. Per-arm noise is about ±15%, so single-probe comparisons are not meaningful; the group means are.

## Linux check (WSL2)

Distro `SiftKit-EXL3-Perf-20260905` (Ubuntu 24.04, kernel 5.15.153.1-microsoft-standard-WSL2, 24 vCPUs, 106 GB, `/opt/exl3` venv: Python 3.13.14, torch 2.13.0+cu132, CUDA 13.2). `feat/moe-cpu-host-affinity` (`28e84f9`) cloned to `/opt/exllamav3-affinity-20261006` and built in place (sm_89, 3 m 51 s). The guest exposes the same topology as Windows (`thread_siblings_list` 2k–2k+1); `exl3_moe_cpu_core_order()` returns `[0, 2, …, 22, 1, 3, …, 23], 12`.

Tests: `test_moe_cpu_host_affinity_.py` 19/19 (Linux branches: `/sys` topology, `sched_setaffinity` over `/proc/self/task`, `sched_getaffinity`, the spawned-worker mask restore), `test_moe_cpu_pool_.py` + `test_moe_cpu_decode.py` 9/9.

End to end: exllamav3 API (`model_init`, `-mcs 408 -cs 8192`, Flash Next copied to ext4), 10 × 256-token generations per load, last 5 scored. Thread masks read from `/proc/<pid>/task/*/status` after generation:

| Arm | Workers | Host process threads | Worker process threads | Decode T/s (mean, min–max) |
|---|---|---|---|---|
| h0 A | 12 | 83 × `0-23` | 12 pinned (0, 2, …, 22), 37 × `0-23` | 18.48 (15.75–21.80) |
| h1 B | 11 | 83 × `22-23` | 11 pinned (0, 2, …, 20), 37 × `0-23` | 20.96 (19.08–23.00) |
| h0 A2 | 12 | 83 × `0-23` | as h0 A | 22.24 (21.51–24.49) |
| h1 B2 | 11 | 83 × `22-23` | as h1 B | 20.47 (19.18–21.78) |

The Linux path applies exactly as designed: every host thread, including those created after the pin, is confined to the reserved core, and the worker's pool threads keep their own LPs. Throughput does not change measurably (h0 20.4 vs h1 20.7 mean; drift across arms from page-cache warm-up is larger than the gap). A sampling arm (`host_cores=0`, `/proc/self/task/*/stat` processor field every 5 ms during decode) explains why: running host threads sat on a worker LP in 19.5% of samples (162/831) versus 50% for random placement. Linux's scheduler mostly puts the floating host on idle SMT siblings, which Windows does not. WSL2 vCPUs are also scheduled by Hyper-V, so guest-side pinning does not map to fixed physical LPs. Net: no regression on Linux and no measurable gain in this guest.

## Load failure note

One load (first attempt of no-MTP h0 A, discarded and re-run) failed with `CPU MoE pinned arena: chunk 43 needs 1024 MiB ... 881 MiB of commit` despite 76 GB free commit before launch; the immediate retry and all later loads succeeded. During a successful load free commit falls to ~2 GB (Tabby ~26 GB private + child ~2.4 GB + ~45 GB arena), so the margin on this machine's 306 MiB pagefile is thin and independent of this change.
