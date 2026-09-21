# EXL3 185k: WDDM paging and budget-crossing validation

Measured 2026-09-21, America/Toronto. Follow-up to the [Windows loader investigation](2026-09-21-exl3-windows-loader-pr-investigation.md). No SiftKit commands or subagents were used.

## Result

**Exceeding the WDDM budget did not produce paging-transfer events during the tested cold prompt or the two controlled over-budget decode stages. A repeatable decode slowdown at the budget boundary was not established.** This is evidence for the tested 185k configuration, not a guarantee of zero performance cost or safety under other memory pressure.

The general caveat remains valid: Windows manages residency, and its budget is an application target with possible paging/performance consequences above it. [Microsoft's budget definition](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/ns-dxgi1_4-dxgi_query_video_memory_info).

## Workload and controls

The process-local NVML admission candidate retained all loader forwards, both headroom comparisons, the reserve, and the margin. Installed EXL3 remained the 1.5.1 wheel used in the preceding investigation. Settings: RTX 4090 / driver 610.47 / WDDM, 185000 context, 185088 Q8 cache, 411 CPU experts, 2048-token chunks, one slot, offloaded vision enabled, MTP disabled, native allocator with expandable segments.

Two fresh loads processed the same 149,851-token prompt. Each had a short warmup. CPU expert swapping was held off with `EXL3_MOE_CPU_SWAP_INTERVAL=1000000000`; Torch and MoE worker thread settings were unchanged. The saved preset remained at 150000. Diagnostic servers used port 8099.

- The natural-output run completed one cold request and 18 cached requests, recovering all three reference markers each time. Its outputs differed across repetitions, so its timings do not establish a matched computational workload.
- The fixed-output run completed one cold request and 15 cached requests. A cached logit-bias vector selected token 279 (` the`), with **no `min_tokens`**. All 16 responses contained the same 256-token output with SHA-256 `ac5f8fff6e0791770fe4f3d739d6a571d5785171ef4ca238abadcbb3930fe55e`. The installed sampler caches this vector per device; this avoids the earlier per-token minimum-length mask confound.

The runs completed **35 measured requests and 9,216 generated tokens**, excluding two 128-token warmups. No sampled allocator retries or OOMs occurred.

Within each loaded process, the pressure sequence was: trim unused Torch reservation, add 512 MiB of live GPU memory, remove it, add it again, remove it again. The added allocation was written on the GPU and synchronized before timing; it was not touched on each decode step. There were three cached requests per stage. This tests memory pressure around the existing workload, not a larger actively accessed KV cache.

The fixed timing stages waited for the preceding large trace export to finish. CPU or GPU clock settings were not changed. Timing variation remains visible, and this was not a controlled statistical equivalence benchmark.

## Budget and timing results

The DXGI local process budget was **23,370 MiB**. The cold request reached **350 MiB above budget**, with at least **416 MiB of separately measured device-wide free memory**. An additional shared-memory counter of approximately 47.6 GiB already included intentional CPU-offload allocations; it is not evidence of a 47.6 GiB VRAM spill.

Fixed-output cached requests:

| Stage | DXGI usage relative to budget | Decode rates, tokens/s | Median |
|---|---:|---|---:|
| A: trimmed, no padding | -250 to -248 MiB | 20.41, 20.60, 21.45 | 20.60 |
| B: +512 MiB | +270 to +272 MiB | 20.58, 20.59, 20.91 | 20.59 |
| A: padding removed | -250 to -248 MiB | 22.69, 22.69, 21.15 | 22.69 |
| B: +512 MiB again | +270 to +272 MiB | 20.26, 20.71, 21.76 | 20.71 |
| A: padding removed again | -250 to -248 MiB | 18.88, 16.64, 19.16 | 18.88 |

Over-budget stages retained at least **494 MiB device-wide free**; under-budget stages retained at least **1014 MiB**. Every sampled cached request remained on its intended side of the DXGI budget.

The first B median was nearly identical to the preceding A median. Comparing each B with the mean of its flanking A medians gives -4.87% and -0.36%, but the final A was slower despite memory pressure being removed. The natural-output run also lacked a consistent threshold penalty. These observations do not establish a budget-induced slowdown, and they do not rule out a small performance cost.

Cold prefill rates are not used as a performance A/B: the runs differed in output control and trace/analysis activity. Their role here is functional and residency validation.

## Paging trace

The decisive fixed-output run recorded `Microsoft-Windows-DxgKrnl` with the **Resource keyword, 0x40**, throughout load and inference. The trace contained **148,741 events, with zero events lost**. Provider templates from the installed Windows driver identified `PagingOpTransfer` and `PagingOpVirtualTransfer`; Microsoft documents transfer operations as the mechanism for copying surface data between GPU memory segments. [Microsoft GPU segment documentation](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-segments).

| Interval | Actual paging-transfer events |
|---|---:|
| Loader startup | 10, totalling 24 MiB, associated with the model process |
| Cold 149,851-token request | **0 system-wide** |
| Both over-budget decode stages | **0 system-wide** |
| Below-budget control requests | 27 system-wide; 22 associated with other processes, 5 unresolved |

The trace therefore was capable of observing paging. It did not show it in the cold prompt or over-budget decode stages. This does **not** mean the entire process lifetime or machine was paging-free.

Generic `MemoryTransfer` events also appeared during allocations and releases. Their byte counts were not treated as proof of eviction. Paging operations were assessed separately. Events can be emitted by System/PID 4, so allocation ownership was resolved through `DeviceAllocation` handles where possible. The actual inference PID was **13580**, verified through the live process tree; **26880** was the Windows virtual-environment launcher. Some handles were shared or reused, and five below-budget events remain unassigned. The zero system-wide counts for the target intervals do not depend on ownership inference.

The first run used broader tracing initially, then retained Resource events throughout the remaining workload. Its large trace also had zero lost events, but the narrower second trace is the basis for the paging conclusion. Background/unresolved paging appeared in below-budget control intervals; its contribution to timing variation was not isolated.

## Validation and limits

The [compact evidence](2026-09-21-exl3-wddm-budget-validation-evidence.json) contains request counts, memory ranges, all timing samples, the fixed output hash, paging counts, and runtime hashes. Independent TypeScript parsing verified these records and the absence of paging-transfer events in the target intervals. Diagnostic strict typechecking and `npm run typecheck`, including `npm run lint`, passed. No application runtime code changed; no unrelated application test suite was rerun.

This covers one driver, GPU, model, slot, and approximately 150k occupied context. It does not cover almost-full 185k occupancy, active competing GPU workloads, long idle eviction, sustained production service, image inference, MTP, other drivers, or native Linux. It does not prove that Windows will retain the same budget or residency under future pressure.

Installed `model_ls.py` and `util/memory.py` retained their prior hashes. Separately, the source checkout advanced to `f7d7f2d` at **12:41:25 UTC**, after both GPU runs ended; that change was not installed and was left untouched. No production settings or files were changed by this validation, and no commit or PR was made. Diagnostic servers, GPU monitors, and ETW sessions were stopped; the GPU returned to 0 MiB used / 24,138 MiB free.

Automatic approval review rejected guarded deletion of `.siftkit/tmp/exl3-wddm-validation-20260921` with only **"blocked by policy"**. Approximately **1.48 GiB** of temporary traces, probes, and logs remain there. No alternative deletion was attempted; previous sessions' scratch was left untouched.
