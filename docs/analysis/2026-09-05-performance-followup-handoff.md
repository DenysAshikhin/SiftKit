# EXL3 production performance follow-up handoff (2026-09-05)

Continued in [the controlled follow-up](2026-09-05-performance-controlled-followup.md),
which corrects the screenshot workload comparison and records a fresh local A/B.

## Current state

The production rollout in
[`2026-09-05-production-upstream-sync-handoff.md`](2026-09-05-production-upstream-sync-handoff.md)
is complete through Phase 8. SiftKit `main` is at `4389fabf`, five commits ahead of
`origin/main`; nothing was pushed. Production exllamav3 is at `297711c` and production TabbyAPI
is at `f8b2bec`.

Fresh SiftKit validation after the handoff:

- Node suite: 3,518 passed, 0 failed, 4 skipped.
- Dashboard suite: 399 passed, 0 failed.
- `npm run typecheck`: exit 0, including lint.
- A lint traversal failure exposed that the separate reference repositories `pristine_exle/**` were not
  ignored. `eslint.config.mjs` now ignores that directory; this one-line fix is uncommitted.

No SiftKit tooling was used in this follow-up.

## Production speed retest

Both runs used the production editable install and the same benchmark shape as the Phase 4
record:

```powershell
$env:EXL3_LOAD_ARENA='1'
$env:PYTORCH_ALLOC_CONF='backend:native'
C:/envs/rl313-turbo/Scripts/python.exe eval/perf.py `
  -m D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6 `
  -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192
```

Model load reported 48 CPU-split MoE layers, experts `[102..512)` (410 of 512), AVX512-VBMI,
12 worker threads, 4.29 bpw / 6.01 bpw head, and chunk size 4096. Both benchmark processes exited
0. The GPU returned to 0 MiB afterwards. The first sandboxed attempt failed before benchmarking
because Triton could not write `C:/Users/denys/.triton/cache`; rerunning with normal user-profile
write access resolved that environmental error.

### Results

| Measurement | Run 1 | Run 2 |
|---|---:|---:|
| Prefill 256 | 160.57 | 167.26 |
| Prefill 512 | 246.21 | 285.55 |
| Prefill 1024 | 401.65 | 570.11 |
| Prefill 2048 | 948.13 | 1,026.69 |
| Prefill 4096 | 1,764.98 | 1,765.20 |
| Prefill 8192 | 1,691.66 | 1,772.47 |
| Decode context 0 | 14.42 | 23.90 |
| Decode context 256 | 17.89 | 26.04 |
| Decode context 512 | 24.81 | 25.48 |
| Decode context 1024 | 16.09 | 26.13 |
| Decode context 2048 | 20.70 | 20.98 |
| Decode context 4096 | 19.24 | 26.47 |
| Decode context 7936 | 12.73 | 26.89 |

Rates are tokens/s. Run 2 is the useful repeat. Its 8k prefill is 9.1% below the previously
selected production run 3 (1,949.33), while its decode is generally 15-20% below that run's
30.68-32.78 range. This variability is not new: the three recorded production runs ranged from
1,550 to 1,949 at 8k prefill and from 15.64 to 34.08 across the reported decode points.

## Turbo reference screenshot

`C:/Users/denys/Downloads/turbo_speed_ref.png` records Turbo's RTX 4090 result. The first
panel uses 410 dynamically offloaded CPU experts, chunk 4096, the same 4.29 / 6.01
bpw model, no MTP, and a **24-thread** AVX512-VBMI CPU worker. The local machine is a Ryzen 9
7900X (12 physical cores / 24 logical threads), and the production benchmark deliberately uses
12 worker threads because prior tests found 18 and 24 slower from SMT oversubscription.

| Measurement | Turbo, 24 worker threads | Local run 2, 12 worker threads |
|---|---:|---:|
| Prefill 256 | 382.18 | 167.26 |
| Prefill 2048 | 1,324.16 | 1,026.69 |
| Prefill 4096 | 1,908.88 | 1,765.20 |
| Prefill 8192 | 1,777.80 | 1,772.47 |
| Decode context 0 | 49.27 | 23.90 |
| Decode context 1024 | 49.46 | 26.13 |
| Decode context 2048 | 42.22 | 20.98 |
| Decode context 4096 | 48.37 | 26.47 |
| Decode context 8192/7936 | 48.24 | 26.89 |

The reported 8k prefill rates are effectively equal (1,778 versus 1,772), but the input tokens
are not matched: Turbo's screenshot runs to 32768, while the local run used `-max_length 8192`.
That argument changes the token offsets in `perf.py`. The decode ratio cannot be attributed to
physical-core capacity from worker counts alone. Turbo's second panel also changes chunk size
to 8192, offloaded experts to 426, and reported bitrate to 4.33 bpw; it reaches about 2,465
prefill at 8192.

## Why was an engine rewrite needed if Turbo now gets the same prefill?

Do not conflate the size of the whole rollout with the performance patch:

- The zero-copy performance commit `58d19c0` touches seven files: the CPU `moe_mul1` kernel and
  header, the CUDA/CPU handoff implementation and header, `moe_cpu_host.py`, its tests, and the
  environment-variable documentation. It is +455/-470, largely a complete replacement of the
  staged handoff path.
- The much broader production work removed the independent host-RAM freeze feature from
  exllamav3, TabbyAPI and SiftKit, merged 99 upstream exllamav3 commits and current TabbyAPI, and
  migrated SiftKit data to schema v65. That work was required for cleanup and synchronization,
  not to create the prefill speedup.

At the upstream commit actually tested during development (`c93f3c6`, v1.4.7), pure upstream
measured 1,147 tok/s at 8k prefill and 25-28 tok/s decode. The merged zero-copy engine measured
1,987 prefill and 32-34 decode under the same local benchmark shape. The rewrite removed a host
staging copy that measured only 11-18 GB/s; direct DMA from the page-locked shared arena made the
handoff PCIe-bound at 26-30 ms per roughly 1 GiB layer. Against that historical counterfactual,
the rewrite produced a large and measured prefill gain.

The user subsequently confirmed Turbo is on latest upstream `dev`. The live remote resolves
to `c93f3c6`, the revision already tested; newer published code therefore does not explain his
result. Source inspection confirms upstream still uses host staging. The screenshot alone
does not isolate the patch's benefit because hardware, launch environment, and benchmark
token offsets differ. The controlled follow-up compares both engines on this machine.

## Follow-up outcome

The [controlled investigation](2026-09-05-performance-controlled-followup.md) completed fresh
Windows and upstream-only WSL2 runs at `c93f3c6`, phase profiling, core scaling, and runtime
tuning. Production retains a clear prefill advantage. WSL did not establish a substantial
steady-state speed improvement; six and twelve local workers were close, while 24 SMT workers
were much slower. The recurring decode dip was traced to placement maintenance.

At a 32k cache, production chunk 8192 with 410 CPU experts fit and reached 2.0–2.6k prefill
tok/s across two runs. The saved 155k preset, native Linux, and the local patch on Linux remain
unvalidated by these tests. The WSL distro is retained in the
[environment catalogue](../exl3-wsl-environment.md). See the controlled record for settings,
variation, validation, and cleanup details.

Primary background record:
[`2026-09-05-qwen38-flash-next-engine.md`](2026-09-05-qwen38-flash-next-engine.md).
