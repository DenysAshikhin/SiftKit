# PR 341 hardening commits: GPU validation (2026-09-06, completed 18:13 America/Toronto)

Continues [the PR validation record](2026-09-06-zero-copy-pr-validation.md). Validates the
two hardening commits (`baa3728` layout contract / parent-owned chunk release / transactional
startup / profiler fixes, `ba5473b` drop child-side unlink test) on the GPU. No SiftKit
tooling was used. Paused on request after the Windows probes and one Windows benchmark run
(15:15), resumed 17:15 and completed 18:13: Windows 5 runs + profiler, WSL 3 probes + 5 runs +
profiler, all exit 0. The earlier drafts (`pr_results.md`, `pr_section.md`) are kept on the local branch
`pr341-gpu-validation-artifacts` but superseded: the PR gets a single replacement `## Results`
section, applied by hand, reproduced under Closeout.

## State

- Fork `DenysAshikhin/exllamav3` branch `engine-zero-copy` pushed to `ba5473b`
  (was `4bc002a`). PR 341 now shows 5 commits; its description gained the section
  "Lifecycle, layout and profiler hardening (third commit)" and the Validation block now
  reads 17 passed / 2 skipped (Windows), 17 passed / 1 skipped (Linux).
- **PR body discrepancy (found 18:15).** The live PR 341 body, last updated 16:05 local
  (`2026-09-06T20:05:36Z`, 50 minutes after the pause), contains neither the third-commit
  section nor any `## Validation` block, including the original one the `section` mode of
  `pr_patch.py` asserted on. Its headings are Purpose, Changes, Results, Review fixes (second
  commit), Note on `-Ofast`. No comments, reviews or issue events exist on the PR, so the
  rewrite was a direct description edit after the earlier session. The body as found is
  saved as `pr_body_current.md` on the artifacts branch. Nothing was patched on top of it.
  Closeout decision (18:30): the existing `## Results` section is replaced by hand with the
  single vs-upstream section under Closeout; no third-commit section, no dated runs.
  `pr_patch.py section` no longer applies: its assertion on the original Validation block
  fails against the current body.
- Pristine checkout `pristine_exle/exllamav3` at `ba5473b`, clean. Windows production
  checkout `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench` at `c9554e9`
  (`a5ecc0b` + both commits cherry-picked), extension unchanged. WSL distro
  `SiftKit-EXL3-Perf-20260905` has `/opt/exllamav3-zc` at `ba5473b`; distro stopped.
- Old `stage-wait` label sweep: nothing greps for it. Only historical mentions remain in
  `docs/analysis/2026-09-05-performance-controlled-followup.md` and the plan file.
- Scratch directory `.scratch-pr341-gpu/` was deleted at closeout. Every script, log, `.pt`
  and PR draft (39 files) is committed under that path on the local branch
  `pr341-gpu-validation-artifacts` (`9a3163b`, one commit on top of this branch's HEAD, not
  pushed). Restore with `git checkout pr341-gpu-validation-artifacts -- .scratch-pr341-gpu`;
  the path is gitignored on every other branch. GPU 0 MiB, WSL distro stopped, `/dev/shm`
  empty after every WSL run.

## Probes: swizzle on/off through the reported-layout path (Windows production `c9554e9`)

`swz_check.py` loads the benchmark model (`-mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr
-max_length 32768`, `EXL3_LOAD_ARENA=1 EXL3_MOE_MEMOPS=0`), prefills a 2047-token wikitext
window, takes the next-token logits, greedy-decodes 32 tokens, saves logits and ids.
`EXL3_MOE_STREAM_DEBUG=1` confirmed the streamed path ran on 47 of 48 offloaded layers in
every probe (150-300 of 410 experts streamed per layer; `prefill()` stops before the last
layer's MLP, so layer 47 never streams).

| Pair | argmax | first greedy mismatch | max abs logit diff |
|---|---|---:|---:|
| swizzle 1 vs swizzle 0 | 279 / 279 | token 6 | 1.078 |
| swizzle 1 vs swizzle 1 (repeat, noise floor) | 279 / 279 | token 6 | 1.037 |
| swizzle 0 vs swizzle 1 (repeat) | 279 / 279 | token 7 | 1.200 |

All three runs exited 0, produced coherent continuations of the Du Fu article, and agreed on
the next token. The swizzle-on/off difference is the same size as the run-to-run difference
with swizzle fixed, so the reported-layout path is consistent with native within the engine's
existing nondeterminism. The nondeterminism itself (two identical swizzle=1 runs differ by
~1.0 in logits and diverge at greedy token 6) is pre-existing and not investigated; likely
float summation order in the CPU worker's dynamic partitioning or GPU atomics.

## Probes: WSL2 zero-copy (`/opt/exllamav3-zc` at `ba5473b`, `/dev/shm` remounted to 100 GB)

Same probe, same model over `/mnt/d`. All three exited 0, streamed 47 of 48 layers, produced
coherent Du Fu continuations, agreed on argmax 279, and left `/dev/shm` empty (`SHM_LEFT 0`
after each), so the transactional startup and parent-owned chunk release clean up on Linux.

| Pair | argmax | first greedy mismatch | max abs logit diff |
|---|---|---:|---:|
| swizzle 1 vs swizzle 0 | 279 / 279 | token 7 | 1.051 |
| swizzle 1 vs swizzle 1 (repeat, noise floor) | 279 / 279 | token 6 | 1.188 |
| swizzle 0 vs swizzle 1 (repeat) | 279 / 279 | token 6 | 1.047 |
| Windows swizzle 1 vs WSL swizzle 1 | 279 / 279 | token 6 | 1.000 |

The swizzle-on/off difference is below the WSL noise floor, and the Windows-to-WSL
difference is the same size, so the two platforms and both layouts sit within the engine's
existing run-to-run nondeterminism.

## Windows benchmark, 5 runs (`c9554e9`, same command as the earlier 5+5 record)

| Prefill tok/s | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 4096 | 1785 | 1948 | 1675 | 2128 | 1944 | 1675 | 1944 | 2128 |
| 8192 | 1729 | 1814 | 1592 | 1948 | 1814 | 1592 | 1814 | 1948 |
| 16384 | 1732 | 1794 | 1622 | 2009 | 1833 | 1622 | 1794 | 2009 |
| 32768 | 1663 | 1754 | 1588 | 1980 | 1832 | 1588 | 1754 | 1980 |

Earlier `a5ecc0b` min/median/max for comparison: 1453/1914/2134 (4k), 1406/1787/1999 (8k),
1412/1759/2009 (16k), 1392/1741/1992 (32k).

| Decode tok/s | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ctx 0 | 24.97 | 33.60 | 33.81 | 34.50 | 31.86 | 24.97 | 33.60 | 34.50 |
| 1024 | 24.06 | 34.17 | 33.07 | 33.07 | 34.09 | 24.06 | 33.07 | 34.17 |
| 2048 | 21.38 | 27.63 | 27.41 | 25.48 | 27.18 | 21.38 | 27.18 | 27.63 |
| 4096 | 26.13 | 33.82 | 33.39 | 34.23 | 29.83 | 26.13 | 33.39 | 34.23 |
| 8192 | 25.45 | 33.28 | 31.27 | 30.20 | 31.56 | 25.45 | 31.27 | 33.28 |
| 16384 | 25.83 | 34.44 | 33.64 | 33.76 | 32.58 | 25.83 | 33.64 | 34.44 |
| 32512 | 27.57 | 32.33 | 33.03 | 34.11 | 34.87 | 27.57 | 33.03 | 34.87 |

All five exited 0 with no tracebacks or warnings. Prefill medians match the earlier
`a5ecc0b` medians within 2-3% and every run sits inside the earlier bimodal range. Decode
runs 2-5 are in the 30-35 band the earlier record reported (its runs were 32-35 with one
low run); run 1, the only run before the 2-hour pause, sat in the 24-27 band the earlier
record attributed to machine state. The ctx-2048 decode dip (25-28 against 33-34 around it)
is the placement sweep the earlier record already identified, present in all of its runs too.

## WSL2 benchmark, 5 runs (`/opt/exllamav3-zc` at `ba5473b`, same command as the earlier record)

| Prefill tok/s | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 4096 | 1689 | 2104 | 2133 | 2009 | 2044 | 1689 | 2044 | 2133 |
| 8192 | 1612 | 1946 | 2003 | 1900 | 1928 | 1612 | 1928 | 2003 |
| 16384 | 1642 | 1973 | 2038 | 1938 | 1962 | 1642 | 1962 | 2038 |
| 32768 | 1614 | 1959 | 2016 | 1911 | 1927 | 1614 | 1927 | 2016 |

Earlier `4bc002a` min/median/max for comparison: 2077/2135/2147 (4k), 1960/2005/2011 (8k),
1995/2052/2053 (16k), 1968/2024/2029 (32k).

| Decode tok/s | run1 | run2 | run3 | run4 | run5 | min | median | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ctx 0 | 29.29 | 28.72 | 30.42 | 28.89 | 28.92 | 28.72 | 28.92 | 30.42 |
| 1024 | 29.45 | 30.34 | 29.81 | 27.80 | 28.70 | 27.80 | 29.45 | 30.34 |
| 2048 | 16.58 | 17.15 | 17.04 | 15.58 | 15.80 | 15.58 | 16.58 | 17.15 |
| 4096 | 30.14 | 29.43 | 29.56 | 26.67 | 28.43 | 26.67 | 29.43 | 30.14 |
| 8192 | 28.27 | 27.81 | 28.08 | 25.50 | 28.09 | 25.50 | 28.08 | 28.27 |
| 16384 | 29.22 | 29.80 | 30.80 | 27.87 | 29.17 | 27.87 | 29.22 | 30.80 |
| 32512 | 29.96 | 29.68 | 30.77 | 28.40 | 29.18 | 28.40 | 29.68 | 30.77 |

Earlier `4bc002a` decode medians for comparison: 31.45 (ctx 0), 31.28 (1k), 17.60 (2k),
31.19 (4k), 30.66 (8k), 31.47 (16k), 31.95 (32k).

All five exited 0, no tracebacks, `SHM_LEFT 0` after each. Run 1 was the first model load
after the distro started (cold `/mnt/d` reads) and is 20% below the others at every prefill
length; runs 2-5 span 1900-2133 and overlap the earlier record's 1960-2147. Medians for runs
2-5 alone are 2074 / 1937 / 1967 / 1943, 2-4% under the earlier medians. Decode is
consistently about 2 tok/s (6%) under the earlier record at every context, including the
ctx-2048 sweep (16.6 versus 17.6), across all five runs. Windows decode the same afternoon
was 33-35, at or above its earlier record, so the machine was not slow. This has not been
A/B'd against `4bc002a` in the same distro session and the two hardening commits do not
touch the decode hot path (layout report, chunk ownership, startup transaction, profiler
brackets); it is recorded as an open observation, not attributed.

`wsl_prof.log` (exit 0, `SHM_LEFT 0`) printed 16 lines. Per-layer `raw-slot-wait` was
0.02-0.11 ms throughout (`dma` 6-26 ms, `compute` 2-21 ms per layer), so slot reuse is not a
measurable wait on Linux either. `host-enqueue` is 6-23 ms per layer against 3-14 on Windows,
the same platform gap the earlier record noted.

## Profiler finding (not fixed, outside the agreed Group A scope, deferred at closeout)

Impact: diagnostic only. `EXL3_MOE_STREAM_PROF` is off by default and the miscount affects
nothing but the printed line, so no throughput, logit or benchmark figure in this record or
in PR 341 depends on it. What it has cost so far: the probes printed no profiler line, and
the `win_prof`/`wsl_prof` lines are per-48-calls samples with a one-layer lag rather than
per-pass samples. Details:

`EXL3_MOE_STREAM_PROF` reports when `n % L == 0` with `L = len(self.specs)` (48). Because
`prefill()` skips the last layer's MLP, each prefill pass streams 47 layers, so a single-pass
prefill never reports (the probes printed no profiler line despite `EXL3_MOE_STREAM_PROF=1`),
and multi-chunk runs report every 48 layer-calls, not per pass, with `rows` taken from
whichever call crossed the boundary. GPU-side figures (`raw-slot-wait`, `dma`, `compute`)
are per harvested layer and unaffected; host-side `router-sync` and `host-enqueue` are
per-48-calls, about 2% off a true per-pass figure. This is the plan's Task 6 "pending/final
samples" item. A pass-boundary trigger (`layer_idx <= last_idx` after harvesting the pending
events) would fix cadence and the one-layer lag together. 
`win_prof.log` (perf.py `-sg`, profiler on, exit 0) printed 10 lines at the 48-call cadence.
Per-layer `raw-slot-wait` was 0.01-0.05 ms for rows 512-4096 and peaked at 0.13 / 0.39 ms on
the two samples that straddled a pass boundary (rows 256 and the final 4096 sample), against
`dma` 3-20 ms and `compute` 1-18 ms per layer. The reported-layout slot path is not a
measurable wait on Windows. Host-side `router-sync` 0.03-9 ms and `host-enqueue` 2.7-13.6 ms
per layer scale with rows as before.

## Resume

Restore the scratch directory first, it is gitignored on this branch:
`git checkout pr341-gpu-validation-artifacts -- .scratch-pr341-gpu`.
Scripts in `.scratch-pr341-gpu/` (Git Bash orchestrator `run_all.sh`, WSL script
`run_wsl.sh`, probe `swz_check.py`, `compare.py`, `summarize.py`, PR body updater
`pr_patch.py` with `pr_section.md` and `pr_results.md`). Logs and `.pt` files for
every run are kept. The full set has been run; to rerun it, use one detached background
command (`SKIP_PROBES`, `START_RUN`, `SKIP_WIN` select the subset):

```powershell
$env:SKIP_PROBES='1'; $env:START_RUN='2'
Start-Process 'C:\personal\Git\usr\bin\bash.exe' '/c/Users/denys/Documents/GitHub/SiftKit/.scratch-pr341-gpu/run_all.sh' -WindowStyle Hidden `
  -RedirectStandardOutput .scratch-pr341-gpu\run_all_resume.out -RedirectStandardError .scratch-pr341-gpu\run_all_resume.err
```

Launch it detached like this, not through the agent Bash tool: that tool caps tasks at 10 minutes
and the set takes far longer. `run_all.sh` exports `C:\personal\Git\usr\bin` onto `PATH` itself,
because a bare `bash.exe` started from PowerShell has no `date`/`seq`, which silently skipped the
whole run loop and jumped to `win_prof` on the first resume attempt. It also exports
`MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`: without them Git Bash rewrote the `wsl.exe
--exec bash /mnt/c/...` argument to `C:/personal/Git/mnt/c/...`, and the WSL set "finished"
in two seconds with `No such file or directory` in `wsl_driver.log`. Both fixes are in the
script now; `SKIP_WIN=1` was used to rerun only the WSL set.

That runs Windows runs 2-5, `win_prof`, then the WSL set (remounts `/dev/shm` to 100 GB,
three probes, five runs, `wsl_prof`, each log ending with `SHM_LEFT n`), stops WSL and writes
`ALL DONE` to `progress.txt`. `SKIP_WIN=1` jumps straight to WSL. Stopping it needs killing
the `bash.exe`/`python.exe` processes whose command lines contain `scratch-pr341-gpu` or
`exllamav3-dev-qbench` (a TaskStop on the shell leaves the loop running); do not match
`perf.py` from a PowerShell whose own command line contains it. Then:

```bash
cd .scratch-pr341-gpu && python summarize.py            # tables + probe lines (any python)
PY=/c/envs/rl313-turbo/Scripts/python.exe               # compare.py needs torch
$PY compare.py wsl_swz1.pt wsl_swz0.pt; $PY compare.py wsl_swz1.pt wsl_swz1b.pt
grep -h "stream prof" win_prof.log wsl_prof.log | head  # raw-slot-wait values
python pr_patch.py append pr_results.md                 # only if the drafted section is not on PR 341 yet
```

Probe pitfalls already solved in `swz_check.py`: needs a `__main__` guard (spawn re-imports
it), `@torch.inference_mode()` on `main` (`get_test_state` zeroes inference tensors), a
recurrent test state from `cache.get_test_state(0)`, and a fresh params dict per call (the
embedding module stores `input_ids` in params).

## Closeout (18:30)

- PR 341 body: the existing `## Results` section is replaced by hand with the section below.
  Upstream figures are the `c93f3c6` runs from
  [the controlled follow-up](2026-09-05-performance-controlled-followup.md) (Windows 4k-32k
  single run plus the 8k/32k adjacent repeat; WSL2 memops-0 run plus the aligned 8k/32k
  repeat); this-branch figures are the 5-run tables above.
- WSL decode gap (about 2 tok/s under the earlier record at every context): recorded as
  open and unattributed. No A/B against `4bc002a`; Windows decode the same afternoon was at
  or above its record, so machine state is the likely cause.
- Profiler cadence fix: deferred, diagnostic only (see Profiler finding).
- `.scratch-pr341-gpu/` moved to the local branch `pr341-gpu-validation-artifacts` and
  deleted from the working tree.

### Replacement `## Results` section for PR 341

```markdown
## Results

RTX 4090, Ryzen 9 7900X, `td_flash-next_4.05bpw_h6_ng6`, `perf.py -mcs 410 -mct 12 -cs 32768
-chunk_size 4096 -ngr -max_length 32768`, `EXL3_LOAD_ARENA=1 EXL3_MOE_MEMOPS=0`,
`PYTORCH_ALLOC_CONF=backend:native`, torch 2.13.0+cu132. This branch: 5 runs per platform,
median (min-max). Upstream `c93f3c6`: same command, 1-2 runs, observed values.

| Prefill tok/s | 4096 | 8192 | 16384 | 32768 |
|---|---:|---:|---:|---:|
| Upstream, Windows | 895 | 855-1025 | 836 | 824-1020 |
| Upstream, WSL2 | 1131 | 931-1039 | 906 | 895-1045 |
| This branch, Windows (`/Ox`) | 1944 (1675-2128) | 1814 (1592-1948) | 1794 (1622-2009) | 1754 (1588-1980) |
| This branch, WSL2 (Ubuntu 24.04, `-Ofast`) | 2044 (1689-2133) | 1928 (1612-2003) | 1962 (1642-2038) | 1927 (1614-2016) |

| Decode tok/s, median | ctx 0 | ctx 4096 | ctx 32512 |
|---|---:|---:|---:|
| Upstream, Windows | 24.2 | 21.9 | 25.0 |
| Upstream, WSL2 | 25.8 | 25.1 | 26.4 |
| This branch, Windows | 33.6 | 33.4 | 33.0 |
| This branch, WSL2 | 28.9 | 29.4 | 29.7 |

Decode varies with machine state more than with the patch (one Windows run sat at 24-27
across all contexts); the ctx-2048 placement sweep is excluded above. All runs exited 0.
```
