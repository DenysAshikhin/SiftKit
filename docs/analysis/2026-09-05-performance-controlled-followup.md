# EXL3 controlled performance follow-up (2026-09-05)

Investigation ran September 5–6, 2026, America/Toronto.

Continues [the handoff](2026-09-05-performance-followup-handoff.md). Investigation only;
no engine changes, production installs, commits, worktrees, or SiftKit tooling. The user expanded
scope to upstream-only WSL2 comparison, thread scaling, and further throughput experiments.
The new WSL distro is retained and [catalogued](../exl3-wsl-environment.md) at their request.

## Result

- Keep the production zero-copy patch on this machine: at chunk 4096, fresh Windows stock
  reached 824–1020 tok/s at 32k prefill; WSL stock reached 895–1060; production reached
  1749–1780. Source inspection and production profiling support removal of host staging as
  the important local difference. Turbo's unknown host/launch details still prevent an exact
  attribution of his stock-engine result; newer published code is not the explanation.
- Core scaling is not linear here. Six and twelve workers both deliver about 25 tok/s on the
  fixed short decode test; 24 SMT workers deliver about 4.3. Do not extrapolate Turbo's speed
  from his worker count.
- The useful tuning result is **chunk 8192 with 410 CPU experts and a 32768 cache**: two
  long-prefill runs reached 2044–2591 tok/s at 32k. It fits without increasing CPU offload.
  Treat the range as observed variability, not a guaranteed percentage gain. A reliable
  additional decode-speed improvement was not established.
- Placement maintenance explains most of the recurring decode dip: a 740 ms pause on
  Windows production and a 2697 ms pause in the final WSL run. Benchmark warmup length
  determines which displayed context contains the sweep.
- No engine code, production Python install, preset, or model weights changed. The retained
  WSL distro and its documented host memory limit are the persistent environment additions.

## Corrections to the comparison

- The user confirmed Turbo uses latest upstream `dev`. Both `git ls-remote origin
  refs/heads/dev` and [upstream history](https://github.com/turboderp-org/exllamav3/commits/dev/)
  resolved to `c93f3c61c35ff300df49205f6f60e716172d1398` during this investigation.
  This is the revision previously tested. Newer published code does not explain the screenshot.
- The screenshot runs through prefill 32768 and decode context 32512. Local follow-up runs
  used `-max_length 8192`. These are different token workloads: `eval/perf.py:86` selects
  prefill tokens at `max_length`; `eval/perf.py:128` selects warmup/decode tokens at
  `2 * max_length` / `3 * max_length`. Matching the displayed context does not match routing.
- Turbo's 24 workers do not establish 24 physical cores or explain a precise 2x speed ratio.
  CPU model, OS, memory bandwidth, and full launch environment remain unknown. Local A/B
  controls hardware without needing those details.
- Screenshot panel two also reports **4.33 bpw**, versus panel one's **4.29 bpw**, besides
  changing chunk size to 8192 and CPU experts to 426. It is not the same configuration.

## Build registry and controls

| Role | Revision | Python source | Extension |
|---|---|---|---|
| Production, retained | `297711ce059f8abb4d2330bb8f30077326b131ab` | `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench` | `C:/envs/rl313-turbo/Lib/site-packages/exllamav3_ext.cp313-win_amd64.pyd` |
| Existing pristine reference, retained | `58d19c0` | `pristine_exle/exllamav3` | Its existing in-place `.pyd`; not used in this comparison |
| Temporary Windows upstream reference, recycled after testing | `c93f3c61c35ff300df49205f6f60e716172d1398` | `.scratch-performance-followup/upstream` during testing | Fresh in-place build, now recoverable from Recycle Bin |

Production extension SHA-256:
`3127e573b69502f8e1423989861fb4f5008a58ce656506b629fbd46cf6dcea7e`.
Fresh Windows upstream extension SHA-256:
`b0547735e36c433ce8c5fc7ac1dea2c06234cdc3df0417f63b0ad399c8f9bf99`.
The temporary checkout is an ordinary shared clone, not a Git worktree. Explicit `PYTHONPATH`
and import-path checks prevent mixing its Python sources with the installed extension.

Common benchmark: Python `C:/envs/rl313-turbo/Scripts/python.exe`, torch `2.13.0+cu132`,
model `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`, `-mcs 410 -mct 12 -cs 32768
-chunk_size 4096 -ngr -max_length 32768`, warmup enabled, `EXL3_LOAD_ARENA=1`,
`PYTORCH_ALLOC_CONF=backend:native`, and explicit `EXL3_MOE_MEMOPS=0` on both engines.
Upstream normally defaults memops to 1; controlling this separates the engine comparison
from the known Windows memops penalty. No benchmark overlaps a build or another benchmark.

## Source findings

Current upstream still stages expert weights. `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp:1929`
copies each matrix with `std::memcpy`; `:1957` starts the staging entrypoint, which creates and
joins scratch threads for each batch. `cpu/moe_handoff.cu:217` runs a dedicated staging thread.
Production instead registers the shared expert arenas for DMA in
`exllamav3/model/moe_cpu_host.py:594`. GPU un-swizzling is already upstream; removing the
host staging copy is still a local difference.

The recurring context-2048 decode dip has a specific candidate cause:
`exllamav3/modules/block_sparse_mlp_cpu.py:563` increments a persistent decode-step counter;
`:574` defaults its interval to 128; `:583` forces the pending placement sweep at 512 steps
when no generator drains it earlier. `perf.py` warms six context points for 100 steps each,
then measures 100 steps per context. The second 512-step sweep falls in measured context 2048
(steps 1001–1100). This predicts a benchmark-position cost, not necessarily an attention
cost at that context. Timing and swap-log evidence are required before attributing the dip.

`EXL3_MOE_CPU_PROF` reports cumulative phase averages every 512 jobs; intervals must be
recovered by subtracting cumulative totals. `EXL3_MOE_HANDOFF_PROF` reports separate 64-job
windows. Worker idle gap, wait-for-input spin, and compute cannot by themselves identify the
complete GPU critical path. Upstream has no `EXL3_MOE_STREAM_PROF` implementation;
production's stream profiler is not a matched upstream instrument.

## Fresh Windows measurements

Both full runs exited 0 with empty stderr. Import paths were checked before each launch;
upstream used the freshly built in-place extension, production the recorded installed extension.
GPU memory returned to zero between runs. Rates are tokens/s; one run per engine so far.

| Measurement | Upstream `c93f3c6`, memops 0 | Production `297711c`, memops 0 |
|---|---:|---:|
| Prefill 256 | 118.57 | 231.18 |
| Prefill 512 | 187.71 | 415.78 |
| Prefill 1024 | 310.60 | 620.52 |
| Prefill 2048 | 539.41 | 908.78 |
| Prefill 4096 | 894.56 | 1806.40 |
| Prefill 8192 | 855.14 | 1775.88 |
| Prefill 16384 | 835.83 | 1800.54 |
| Prefill 32768 | 824.18 | 1749.38 |
| Decode context 0 | 24.22 | 24.69 |
| Decode context 256 | 24.39 | 23.82 |
| Decode context 512 | 23.89 | 25.11 |
| Decode context 1024 | 25.24 | 25.83 |
| Decode context 2048 | 20.68 | 21.73 |
| Decode context 4096 | 21.85 | 25.90 |
| Decode context 8192 | 22.53 | 23.04 |
| Decode context 16384 | 24.25 | 24.07 |
| Decode context 32512 | 25.03 | 26.69 |

Production gained 107.7% at 8k prefill and 112.3% at 32k in this pair. Decode ranges overlap;
the pair does not demonstrate a material decode gain. The stock run had about 18.5 GiB free
physical RAM during decode. GPU telemetry included both P2/11051 MHz and P3/5001 MHz memory
clock states; sampling was once per second and does not isolate individual layer costs.

## Additional experiments

### WSL2 upstream results

Both full upstream runs exited 0, same model path through `/mnt/d`, 410 experts, 12 workers,
32k cache/max length, chunk 4096, native allocator. The first emitted a Triton deprecation
warning, not a fatal error. No weights were duplicated. WSL was stopped after these runs to
release its RAM before Windows measurements.

| Measurement | WSL memops 0 | WSL default memops 1 |
|---|---:|---:|
| Prefill 256 | 171.27 | 169.09 |
| Prefill 2048 | 691.93 | 689.63 |
| Prefill 4096 | 1131.20 | 1138.31 |
| Prefill 8192 | 931.06 | 1057.61 |
| Prefill 16384 | 905.82 | 1075.94 |
| Prefill 32768 | 894.94 | 1059.64 |
| Decode context 0 | 25.83 | 19.82 |
| Decode context 1024 | 25.76 | 20.47 |
| Decode context 2048 | 15.18 | 13.14 |
| Decode context 4096 | 25.10 | 21.09 |
| Decode context 8192 | 24.94 | 20.27 |
| Decode context 32512 | 26.40 | 21.62 |

WSL did not reproduce Turbo's ~1778 prefill / ~49 decode result on this hardware. Its best
observed long-prefill run remains below Windows production. This is WSL2 on kernel 5.15.153.1,
not a native-Linux result. Transparent hugepages are enabled (`always`, defrag `madvise`).

Python 3.13.14, torch 2.13.0+cu132, and primary inference dependencies match Windows. Before
the second run, six transitive packages were also aligned: anyio, click, fsspec,
huggingface-hub, regex, typer. All 50 shared package names then had identical versions.
Consequently, this first pair is not a perfectly isolated memops A/B. Linux Triton 3.7.1 and
Windows triton-windows 3.7.1.post27 necessarily differ. Full environment details and package
snapshot are in [the retained distro catalogue](../exl3-wsl-environment.md).

The final aligned memops-0 repeat enabled CPU/handoff profiling and swap debug, with no
stream profiler (upstream does not implement it). It exited 0 with empty stderr, reaching
1039.18 / 1045.25 tok/s at 8k/32k prefill and 25.19–26.02 tok/s decode outside the sweep
point (15.18). Its 32k prefill is close to the adjacent Windows stock repeat's 1019.71,
well within the wider observed variation; WSL has not established a large steady-state win.

| Final WSL profile context | Gap ms/job | Input wait ms/job | CPU compute ms/job | CPU assignments/row | Maximum gap ms |
|---|---:|---:|---:|---:|---:|
| 0 | 0.065 | 0.157 | 0.592 | 7.74 | 3.462 |
| 1024 | 0.065 | 0.160 | 0.583 | 7.69 | 2.973 |
| 2048 | 0.622 | 0.182 | 0.568 | 7.41 | 2696.636 |
| 4096 | 0.062 | 0.169 | 0.594 | 7.62 | 2.895 |
| 32512 | 0.067 | 0.169 | 0.575 | 7.34 | 2.989 |

Steady worker times and CPU assignment counts closely match Windows production. The much
longer WSL placement pause explains almost all of its context-2048 deficit:
`100 / (100 / 15.18 - 2.696636) = 25.70` tok/s. The sweep reads checkpoint tensors through
the mounted Windows drive; filesystem overhead is a plausible contributor, not an isolated
filesystem A/B result. No native-filesystem weight copy was made.

### CPU-kernel scaling diagnostic

Existing `scripts/moe_cpu_ref.py` from the engine tooling, unchanged, uses the retained pristine
`58d19c0` build. Its extension SHA-256 is
`35271e2dace1d1400cedd69268c26f0c856d94ab41fa47f7a73d9511ae3e1285`.
The script loads 128 real layer-7 experts and times 200 calls after 20 warmups on one fixed
decode-shaped input. **The printed "4 experts" label is stale loop state: the timed case
actually selects 10 experts.** This repeatedly accessed working set is much warmer than
full-model inference; it does not establish DRAM-bound or end-to-end scaling.

| Workers | Microseconds/job |
|---|---:|
| 1 | 2640 |
| 2 | 1393 |
| 4 | 720 |
| 6 | 582 |
| 8 | 734 |
| 12 | 476 |
| 16 | 829 |
| 24 | 1600 |
| 12, closing repeat | 648 |

Scaling is approximately linear through four workers and then flattens/noises; SMT is
substantially slower. All nine output comparisons were bit-exact and processes exited 0.
The existing diagnostic script emits `BufferError: cannot close exported pointers exist`
during shared-arena teardown, so this was not a clean-stderr test run. No helper or engine
code was changed. End-to-end worker-count confirmation remains pending.

### Production phase profile

Full matched 32k run with `EXL3_MOE_CPU_PROF=1`, `EXL3_MOE_HANDOFF_PROF=1`,
`EXL3_MOE_CPU_SWAP_DEBUG=1`, and `EXL3_MOE_STREAM_PROF=1`, otherwise the Windows production
baseline settings. Exit 0, empty stderr. Prefill 8192/32768: 1745.45 / 1780.49 tok/s.
Decode contexts 0/1024/2048/4096/32512: 25.44 / 25.45 / 21.05 / 24.27 / 25.88.

Steady 4096-row streamed-prefill report windows show stage-wait 0.04–0.05 ms/layer,
DMA 23.4–27.7 ms, compute 19.2–21.4 ms, GPU span 29.7–34.6 ms, router wait 8.8–9.3 ms,
and host enqueue 16.2–18.4 ms. These overlapping intervals must not be added as independent
costs. GPU figures lag one layer; use them as approximate phase attribution. In particular,
the negligible stage wait supports the intended removal of the host-staging bottleneck.

Decode handoff averages, grouping each 75 successive 64-job windows into the following
100-token context result (48 layer jobs per token):

| Context | Gap ms/job | Input wait ms/job | CPU compute ms/job | CPU assignments/row | Maximum idle gap ms |
|---|---:|---:|---:|---:|---:|
| 0 | 0.058 | 0.161 | 0.600 | 7.74 | 4.737 |
| 1024 | 0.057 | 0.165 | 0.596 | 7.69 | 6.422 |
| 2048 | 0.208 | 0.171 | 0.611 | 7.42 | 740.014 |
| 4096 | 0.057 | 0.175 | 0.626 | 7.62 | 5.094 |
| 32512 | 0.056 | 0.174 | 0.576 | 7.35 | 4.106 |

The 64-expert placement sweep prints immediately before the 740.014 ms idle gap in the
context-2048 block. Subtracting this pause from that block's measured duration gives
`100 / (100 / 21.05 - 0.740014) = 24.93` tok/s, close to its neighbours. This explains most
of the recurring dip as maintenance landing at that benchmark position. It is a diagnostic
calculation, not a measured optimization or a reason to silently disable dynamic placement.

Subtracting CPU-profiler cumulative totals at job 31744 from job 75264 isolates approximately
the measured decode phase (512-job reporting boundaries): prep 55.65, gate/up GEMV 316.96,
activation/down prep 28.81, down GEMV 167.12, down transform 16.87, accumulation 9.24 us/job.
The two GEMV phases are about 81% of the measured CPU-pool time. Worker input wait/gap also
include host scheduling and enqueue effects; they do not independently measure the complete
GPU critical path.

### End-to-end scaling

Production, same model, `-mcs 410 -cs 32768 -chunk_size 256 -ngr -max_length 512 -spf`,
native allocator, memops 0, warmup on. This fixed short decode workload measures contexts
0 and 256, with 200 warmup and 200 measured forwards; no 512-step placement sweep occurs.
All four runs exited 0, with empty stderr, in the listed order.

| Workers | Context 0 tok/s | Context 256 tok/s |
|---|---:|---:|
| 12 | 25.62 | 25.06 |
| 6 | 23.97 | 24.80 |
| 24 | 4.36 | 4.18 |
| 12, closing control | 24.95 | 24.49 |

Six workers are close to twelve on this workload; 24 SMT workers are dramatically worse.
The return to ~25 tok/s at twelve rules out a sustained machine slowdown as the explanation
for the 24-worker result. This does not extrapolate to a different machine with 24 physical
cores, different memory channels, or native Linux.

### Throughput tuning

All runs below use the same existing model files, 12 workers, 32k cache/max length, RAM
embeddings, native allocator, and memops 0. Changing offload count changes the engine's
reported storage average (4.26/4.29/4.33 bpw); no weights were re-quantized or copied.

| Engine/configuration | Prefill 8192 | Prefill 32768 | Decode ctx 0 / 4096 / 32512 |
|---|---:|---:|---|
| Production, chunk 4096, CPU experts 410 (baseline) | 1775.88 | 1749.38 | 24.69 / 25.90 / 26.69 |
| Production, chunk 8192, CPU experts 426 | 2533.96 | 2523.07 | 24.69 / 25.76 / 22.31 |
| Production, chunk 8192, CPU experts 410 | 2587.31 | 2590.71 | 24.09 / 26.23 / 23.08 |
| Production, same 8k/410, prefill-only repeat | 2002.63 | 2043.60 | not measured |
| Production, chunk 4096, CPU experts 394 | 1789.39 | 1782.09 | 25.74 / 26.56 / 28.66 |
| Stock Windows, chunk 4096, CPU experts 410, staging threads 1 | 951.69 | 965.74 | not measured |
| Stock Windows, same, staging threads 4, adjacent repeat | 1024.52 | 1019.71 | not measured |

The 8k/426 configuration improves long prefill ~43–44%. Its longer generation warmup moves
the second placement sweep into measured context 1024 (20.97 tok/s), and a third sweep into
context 32512. Swap-debug logs confirm both; the other decode points are 22.65–26.14 tok/s.
Sampled peak VRAM: baseline 21388 MiB; 8k/426 21512 MiB. This suggested trying 8k/410 next.

The subsequent **8k/410 run also fits** and keeps the baseline offload count and reported
4.29 bpw. Its first run achieved ~48% higher long prefill than 4k/410. Steady decode was 24.09–26.92
tok/s; the longer warmup again places maintenance in contexts 1024 and 32512. This is the
preferred long-prefill candidate. An exact prefill-only repeat (same warmup/prefill path,
`-sg`) exited 0 with empty stderr but fell to 2002.63 / 2043.60 tok/s at 8k/32k. Report the
observed **2.0–2.6k range**, not a guaranteed 48% gain. Even the lower repeat exceeds the
observed 4k/410 baseline, but the unresolved run-to-run variation remains material.

Reproduce the 8k/410 candidate against the unchanged Windows production installation:

```powershell
$env:PYTHONPATH='D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench'
$env:EXL3_LOAD_ARENA='1'
$env:EXL3_MOE_MEMOPS='0'
$env:PYTORCH_ALLOC_CONF='backend:native'
& 'C:/envs/rl313-turbo/Scripts/python.exe' `
  'D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench/eval/perf.py' `
  -m 'D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6' `
  -mcs 410 -mct 12 -cs 32768 -chunk_size 8192 -ngr -max_length 32768
```

The 4k/394 configuration fits and shifts 16 experts/layer from CPU to GPU. Steady decode was
25.74–28.66 tok/s (21.58 at the sweep point); a repeat is required before claiming a reliable
small gain. A decode-only follow-up (`-spf`, so a different placement history) exited 0 with
empty stderr at 24.39–25.84 tok/s outside its sweep point (21.47). That did not establish a
robust decode improvement; do not recommend higher VRAM occupancy as a proven speed win.
Its long prefill is essentially unchanged. These capacity tests are **32k-cache
results**, not validation of the saved 155k preset.

Single-thread staging is not a win against the adjacent four-thread repeat. The repeat also
shows the initial stock run's 824.18 tok/s at 32k was low: use the observed stock range
824–1020, rather than presenting the first pair's +112% as a universal production gain.
Production's ~1750–1780 still clearly exceeds the best fresh Windows stock result.

## Limits and follow-up

Run-to-run variability remains unresolved. The tested tuning applies to the 32k cache;
the saved 155k preset needs its own capacity/performance validation. WSL2 results do not
validate native Linux or the local zero-copy patch on Linux: WSL ran upstream only.
The allocator was held at native; cudaMallocAsync was not isolated in this investigation.
No clock locks, BIOS changes, engine modifications, or upstream submissions were attempted.

The existing microbenchmark's shared-memory teardown warnings are recorded above.

## Validation and retained state

- Fresh Windows upstream and Linux upstream builds exited 0; source/extension paths and
  hashes were checked. Windows production and pristine extension hashes are unchanged.
- All 17 `perf.py` experiment processes exited 0. The first WSL run emitted a Triton
  deprecation warning; the final WSL profile and Windows benchmark runs had empty stderr.
- Windows upstream `tests/test_moe_cpu_pool_.py`: 1 passed, 14 dependency deprecation
  warnings, 95.29 s.
- WSL upstream same suite: 1 passed, 14 dependency deprecation warnings, 58.12 s.
- Production `tests/test_moe_cpu_offload.py` plus `tests/test_moe_cpu_pool_.py`: 4 passed,
  14 dependency deprecation warnings, 87.41 s.
- `npm run typecheck`: exit 0, including its full `npm run lint` invocation.
- SiftKit Node/dashboard suites were not rerun: no application code changed. The broader
  applicable checks here were the engine kernel suites plus repository typecheck/lint.
- WSL Git integrity and imports from outside its checkout passed. The distro was stopped;
  its source, environment, compiled extension, build objects, package snapshot, workload
  cache, and documented `memory=108GB` / `swap=0` host configuration are retained.

The temporary Windows upstream checkout and 68 temporary files (logs, telemetry, reference
output, installer archive, and validation output) were moved to the Recycle Bin and can be
restored. Automatic approval review rejected permanent deletion, including the exact checkout
path; recoverable cleanup succeeded. Only `wsl/` remains under the scratch directory. The
retained distro is stopped and GPU memory is 0 MiB. Its disk is 14,455,668,736 bytes as observed
at closeout; no duplicate model weights were created.

The retained `.scratch-performance-followup/wsl/` directory has a `RETAINED.md` guard. Existing user changes
to `eslint.config.mjs` are preserved; the original handoff was updated with corrections and
the completed investigation's outcome. No commits or pushes were made.
