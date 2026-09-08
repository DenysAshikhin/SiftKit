# Zero-copy PR: review fixes and 5+5 benchmark validation (2026-09-06)

Continues [the controlled follow-up](2026-09-05-performance-controlled-followup.md). No
SiftKit tooling was used. Investigation and fixes ran September 6, 2026, America/Toronto.

## PR state

Fork `DenysAshikhin/exllamav3`, branch `engine-zero-copy`, base branch `dev` at upstream
`c93f3c6`. Three commits on the branch:

| Commit | Content |
|---|---|
| `58d19c0` | Zero-copy streamed prefill from a page-locked shared arena, GPU un-swizzle, band-unit GEMV partitioning (7 files, +455/-470) |
| `62d1ea8` | Review fixes: arena unlink ownership, `/dev/shm` capacity preflight, stream-profiler normalization, stale batch-ceiling doc; `tests/test_moe_cpu_arena.py` |
| `4bc002a` | `tests/test_moe_cpu_offload.py` inputs scaled to a realistic activation range |

Both fix commits are cherry-picked onto the Windows production checkout
`D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench` (`297711c` -> `58a3101` ->
`a5ecc0b`). The seven kernel/host files were byte-identical between `58d19c0` and `297711c`
before the fixes. The compiled extensions did not change: all fixes are Python and docs.

## Review findings, verified against source

1. **Arena never unlinked (confirmed).** `shutdown()` only called `close()` on the arena
   chunks; only the control block was unlinked. On POSIX the whole offloaded expert set stayed
   in `/dev/shm` until process exit (the smoke run showed 46 leaked objects reclaimed by the
   resource tracker). Fix: the parent unlinks after the child is gone; the child unlinks only
   if it fails before sending the chunk names. The parent now attaches every chunk before
   page-locking so a failed `cudaHostRegister` still releases all of them.
2. **No `/dev/shm` preflight (confirmed).** Layers register incrementally so no upfront total
   exists; the check runs per chunk allocation against `statvfs("/dev/shm")`. Docker's 64 MiB
   default fails on the first 1 GiB chunk before any weights load. Without it tmpfs allocates
   lazily and the failure is a later SIGBUS.
3. **Stream profiler divide-by-zero (confirmed).** Normalized by `L - 1`; crashes at one
   offloaded layer and miscounts the event carried over from the previous pass. Fix counts
   harvested events (`gpu_n`).
4. **Stale 256-expert ceiling doc (confirmed).** `MoeJob` is eight `uint32_t`; no cap is
   enforced. Paragraph replaced.

End-to-end checks in WSL2 with the patched engine: a 512 MiB `/dev/shm` fails immediately
with `CPU MoE shared arena: /dev/shm has 0.50 GiB available, the next 1.00 GiB chunk does
not fit ...` (exit 1, `/dev/shm` empty afterwards); the normal run exits 0 with `/dev/shm`
empty and no resource-tracker warnings. All five WSL benchmark runs below report
`SHM_LEFT 0`.

## Linux kernel test NaN: pre-existing `-Ofast`

`tests/test_moe_cpu_offload.py` failed in WSL2 (never run on Linux before): whole output
rows NaN, deterministic, identical across scalar/avx2/vnni/vbmi tiers, thread counts and
layouts. Upstream `c93f3c6`'s own kernel produces the identical NaN rows on the same inputs,
and the patched kernel matches upstream bit-for-bit on Linux. Rebuilding the patched tree with
`-O3` instead of upstream's `-Ofast` (setup.py line 40, non-Windows) gives output bit-identical
to the Windows build with zero NaNs. Cause: fast-math on the gate activation `exp()` at
overflow magnitudes. The synthetic inputs (unit-scale hidden states against random trellis
codes with randn had-scales) reach that range; the test now uses realistic scale and passes on
both platforms. The `-Ofast` behaviour is an upstream build-flag issue outside the PR and is
noted in the PR description.

## Benchmarks: 5 runs per platform

Common: model `td_flash-next_4.05bpw_h6_ng6`, `-mcs 410 -mct 12 -cs 32768 -chunk_size 4096
-ngr -max_length 32768`, warmup on, `EXL3_LOAD_ARENA=1`, `EXL3_MOE_MEMOPS=0`,
`PYTORCH_ALLOC_CONF=backend:native`, torch 2.13.0+cu132, RTX 4090, Ryzen 9 7900X. Runs were
sequential, one platform at a time, WSL stopped during the Windows set. All ten exited 0 with
no tracebacks or warnings in the logs. Rates are tokens/s.

### Windows production `a5ecc0b` (installed extension `3127e57...`)

| Prefill | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 4096 | 1914 | 1453 | 1476 | 2091 | 2134 | 1453 | 1914 | 2134 |
| 8192 | 1787 | 1406 | 1443 | 1960 | 1999 | 1406 | 1787 | 1999 |
| 16384 | 1759 | 1412 | 1438 | 2009 | 1952 | 1412 | 1759 | 2009 |
| 32768 | 1741 | 1392 | 1416 | 1992 | 1935 | 1392 | 1741 | 1992 |

| Decode | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ctx 0 | 34.16 | 28.78 | 29.16 | 34.95 | 33.00 | 28.78 | 33.00 | 34.95 |
| ctx 1024 | 34.93 | 32.12 | 24.70 | 34.30 | 34.20 | 24.70 | 34.20 | 34.93 |
| ctx 2048 | 27.93 | 25.81 | 20.79 | 27.34 | 27.47 | 20.79 | 27.34 | 27.93 |
| ctx 4096 | 34.07 | 32.38 | 27.47 | 34.45 | 32.71 | 27.47 | 32.71 | 34.45 |
| ctx 8192 | 32.95 | 33.87 | 23.68 | 32.81 | 32.76 | 23.68 | 32.81 | 33.87 |
| ctx 16384 | 34.43 | 30.15 | 28.22 | 33.85 | 33.89 | 28.22 | 33.85 | 34.43 |
| ctx 32512 | 33.96 | 30.18 | 26.42 | 32.46 | 32.79 | 26.42 | 32.46 | 33.96 |

Long prefill is bimodal: runs 1/4/5 at 1.74-1.99k, runs 2/3 at 1.39-1.42k. Decode is
mostly 32-35 with run 3 low throughout; the prior record's 24-27 came from a different
machine state, not different hot-path code. The ctx-2048 dip is the placement sweep.

### WSL2 zero-copy `4bc002a` (`/opt/exllamav3-zc`, extension `6beb1d5...`, `-Ofast` build)

| Prefill | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 4096 | 2104 | 2077 | 2147 | 2135 | 2146 | 2077 | 2135 | 2147 |
| 8192 | 1972 | 1960 | 2008 | 2005 | 2011 | 1960 | 2005 | 2011 |
| 16384 | 2020 | 1995 | 2052 | 2052 | 2053 | 1995 | 2052 | 2053 |
| 32768 | 1998 | 1968 | 2024 | 2024 | 2029 | 1968 | 2024 | 2029 |

| Decode | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ctx 0 | 31.71 | 29.22 | 31.25 | 31.45 | 31.84 | 29.22 | 31.45 | 31.84 |
| ctx 1024 | 31.28 | 29.96 | 29.61 | 31.76 | 32.22 | 29.61 | 31.28 | 32.22 |
| ctx 2048 | 17.83 | 16.60 | 17.20 | 17.60 | 17.83 | 16.60 | 17.60 | 17.83 |
| ctx 4096 | 31.68 | 29.48 | 29.29 | 31.32 | 31.19 | 29.29 | 31.19 | 31.68 |
| ctx 8192 | 30.98 | 28.74 | 28.87 | 31.21 | 30.66 | 28.74 | 30.66 | 31.21 |
| ctx 16384 | 32.02 | 29.72 | 29.36 | 31.47 | 32.04 | 29.36 | 31.47 | 32.04 |
| ctx 32512 | 31.95 | 30.12 | 30.38 | 32.41 | 32.28 | 30.12 | 31.95 | 32.41 |

WSL2 with the patch is tighter and faster at long prefill than Windows (1968-2029 versus
1392-1992 at 32k), roughly 2x the 895-1060 that stock upstream reached in the same distro on
2026-09-05. Decode is 29-32 outside the sweep; the ctx-2048 sweep costs more under WSL
(checkpoint reads through `/mnt/d`), consistent with the 2.7 s pause measured earlier.

## Validation

- Pristine tree, Windows: `tests/test_moe_cpu_arena.py`, `test_moe_cpu_offload.py`,
  `test_moe_cpu_pool_.py`: 8 passed, 1 skipped (POSIX-only unlink test).
- Production tree, Windows: same suites, 8 passed, 1 skipped.
- WSL2 patched tree: `test_moe_cpu_arena.py` 5 passed (including the unlink test);
  `test_moe_cpu_offload.py` 3 passed after the input rescale.
- Preflight and arena-release end-to-end runs as described above.
- SiftKit suites not rerun: no SiftKit application code changed.

## Retained state and cleanup

- WSL distro keeps `/opt/exllamav3-zc` (patched checkout at `4bc002a`, ~1 GB, built with
  upstream's `-Ofast`). The temporary `-O3` diagnostic checkout was deleted. The runtime
  `mount -o remount,size=100G /dev/shm` is not persistent; the run script reapplies it.
- The scratch directory `.scratch-performance-followup/pr-validation/` (run scripts, logs,
  diagnostics, Windows reference tensor) was deleted at completion; this record keeps the
  numbers. `.scratch-performance-followup/wsl/` remains retained.
- GPU memory 0 MiB and WSL stopped at closeout. No SiftKit commits or pushes.
