# Windows EXL3 autosplit: PR candidate with measuring forwards retained

Measured 2026-09-21, America/Toronto. Follow-up to the [185k validation report](2026-09-20-exl3-185k-context-validation.md). No SiftKit commands or subagents were used.

This report records the prototype before PR publication. See the later [regression history and draft PR](2026-09-21-exl3-loader-regression-history.md)
and [production deployment](2026-09-21-exl3-pr389-production-deployment.md) for the implementation and installed revision.

## Finding

**A process-local change to the loader's free-memory source loaded 185k with every measuring forward, both admission checks, and the loading-time allocator cap enabled.** The unchanged-source control reproduced the 185k rejection. The candidate then completed a 149,851-token prompt plus 1,024 generated tokens, followed by an identical cached request.

This establishes a concrete upstream PR direction. It does not establish safe default behavior across Windows drivers, freedom from paging, or Linux performance equivalence. At this prototype stage, no production implementation, installation change, preset change, commit, or PR was made.

Follow-up: [WDDM budget/paging validation](2026-09-21-exl3-wddm-budget-validation.md) found no paging-transfer events during its cold prompt or controlled over-budget decode stages. It did not establish a repeatable budget-related slowdown or prove performance equivalence.

## Cause and scope

The installed loader uses CUDA free memory for three related decisions:

- `exllamav3/util/memory.py:27`: `set_memory_fraction_reserve` derives a cumulative Torch reservation ceiling from current reservation + free memory - requested reserve.
- `exllamav3/util/memory.py:50`: `set_memory_fraction_use` adds current reservation to the smaller of the requested load allowance and free memory.
- `exllamav3/model/model_ls.py:244`: the second admission check adds free memory to Torch reserved-but-unallocated memory and compares this with the measured transient plus a 256 MiB margin.

On this WDDM system, CUDA free memory follows the Windows process budget rather than all unused dedicated VRAM. The retained September 19 DXGI measurements showed a 23,370 MiB process budget, with CUDA free matching budget minus process usage. Device-wide free was about 768 MiB higher. That gap is not a fixed platform constant or an allocation that can simply be subtracted.

Microsoft defines the DXGI budget as the application's target and documents possible paging/stuttering above it. Therefore, using device-wide free memory is an admission-policy change, not proof that the Windows budget is erroneous. [Microsoft budget semantics](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/ns-dxgi1_4-dxgi_query_video_memory_info).

The existing [PR #386](https://github.com/turboderp-org/exllamav3/pull/386) remeasurement fix was present in both runs. It addresses persistent allocations counted again as transient headroom; it does not resolve this remaining WDDM limit.

## Controlled probe

Both processes used EXL3 1.5.1, deployed source `8ddd14b5c3072bdcd9c49bb14648b1d9f5b1bcd0`, Torch 2.14.0+cu132, driver 610.47, and an RTX 4090 in WDDM mode. Settings matched the preceding report: 411 CPU experts, 2,048-token chunks, one slot, Q8 KV cache, streamed n-grams, offloaded vision enabled, MTP disabled, and native allocation with expandable segments. The saved preset remained at 150,000; diagnostic launch overrides requested 185,000 / 185,088 cache tokens on port 8099.

The candidate replaced only the free-memory reads in the three locations above with the `free` field from `nvmlDeviceGetMemoryInfo`. It selected the adapter by Torch's CUDA UUID through `nvmlDeviceGetHandleByUUID`, used the CUDA device's total memory as the fraction denominator, and queried NVML directly through the installed driver DLL. No dependency installation was needed.

The `reserve_per_device` path was exercised. The `use_per_device` replacement was present but was not exercised by this Tabby configuration. CUDA free memory remained unchanged globally and was still recorded by the telemetry sampler. All source substitutions existed only in the diagnostic Python process launched by a temporary TypeScript harness.

At the final `lm_head` check, MiB:

| Quantity | CUDA-source control | NVML-source candidate |
|---|---:|---:|
| Live Torch allocation | 22,492.48 | 22,492.48 |
| Largest measured transient | 548.95 | 548.95 |
| Cumulative loader budget | 22,846.00 | 23,612.04 |
| Budget after live allocation + transient | **-195.43** | **+570.60** |
| Reusable headroom using CUDA free | 437.52 | 437.52 |
| Reusable headroom using NVML free | 1,203.55 | 1,203.55 |
| Required transient + margin | 804.95 | 804.95 |
| Enforced loading memory fraction | 0.930079 | 0.961265 |
| Outcome | Rejected | Loaded |

Both runs recorded 82 admission-measurement points across vision and text. The candidate's remaining headroom exceeded the transient-plus-margin requirement by 398.60 MiB. The failure message truncates the transient to 548 MiB; that number is not the deficit.

The candidate retained `module.forward`, `autosplit_extra_measure`, persistent-allocation remeasurement, both comparisons, the requested 96 MiB reserve, and the default 256 MiB margin. The cap was not set to 1.0 during loading. The loader's normal post-load reset restored 1.0 for inference in both the previous normal runs and this candidate.

A separate **230,000-context negative control** used the same NVML-source candidate. It was rejected at `lm_head` by the intact transient-budget comparison, with a 155.40 MiB deficit. This verifies that the policy still rejects a load beyond its budget. It is not a test of a failed physical CUDA allocation.

## Inference validation

| Request | Input tokens | Generated tokens | Cached input | Prefill tokens/s | Decode tokens/s |
|---|---:|---:|---:|---:|---:|
| Cold | 149,851 | 1,024 | 0 | 948.00 | 21.38 |
| Cached repeat | 149,851 | 1,024 | 149,760 | — | 21.79 |

Both responses recovered the beginning, middle, and end markers. Greedy sampling, thinking disabled, no tools/grammar, no forced logit bias, and no `min_tokens`. Automatic streaming selection reported 8. The prompt SHA-256 matched the preceding report: `1fbed9b1b0a0b159943f32b814a23e0633f1d8f5f66773d6c1dbd2a82618e71c`.

Across 308 once-per-second Torch samples, maximum allocated memory was 22,939.54 MiB and maximum reservation was 23,248 MiB. Minimum CUDA free was zero; minimum separately sampled device-wide free was 417 MiB. Allocation retry and OOM counters remained zero. A separate TypeScript verifier checked response counts, markers, hashes, cold-cache status, loader guard arithmetic, allocator counters, and unchanged installed/source hashes.

These are sampled observations, not a paging trace or a full-capacity stress test. The requests occupied approximately 151k of the configured 185k capacity. They do not validate a nearly full 185k prompt, sustained service, concurrency, image inference, MTP, or throughput equivalence to Linux.

The compact [verified evidence](2026-09-21-exl3-windows-loader-pr-evidence.json) retains the final guard records, negative control, request usage, memory extrema, and source hashes.

## Recommended PR scope

Target `turboderp-org/exllamav3:dev`, with a title such as **Autosplit: distinguish WDDM process budget from dedicated-memory headroom**.

1. Add one small headroom helper in `util/memory.py`, selected specifically for Windows CUDA devices using WDDM. Use device-wide dedicated-memory availability consistently in the two fraction setters and the LS loader's headroom check. Keep all existing measurement, reserve, margin, and OOM behavior.
2. Keep native Linux, other accelerator backends, and Windows TCC on their current memory-query path. Windows CUDA uses NVML to identify WDDM versus TCC; native Linux and HIP must not initialize NVML. Do not globally replace `torch.cuda.mem_get_info`.
3. Map devices by CUDA UUID or PCI identity, including reordered visible devices. Do not assume CUDA and NVML ordinals match. Validate query results and report query failures explicitly; never substitute total capacity or a hardcoded extra allowance.
4. Preserve the distinction between device-wide free VRAM and the DXGI process budget in diagnostics. Use NVML's actual `free` field, which excludes its separate reserved category, rather than `total - used`. [NVIDIA framebuffer counter definitions](https://docs.nvidia.com/deploy/nvidia-smi/index.html#fb-memory-usage).

The code change should stay in the loader's admission path. No SiftKit preset tuning or Tabby bypass is required for the demonstrated result. Changing the Windows default should depend on the validation below: a successful CUDA allocation alone cannot establish physical residency or acceptable performance. NVIDIA documents that system-memory fallback can permit continued execution with lower performance near capacity. [NVIDIA fallback behavior](https://nvidia.custhelp.com/app/answers/detail/a_id/5490).

## Evidence required before upstream acceptance

- Regression tests for both reserve and explicit-use paths, previous components already resident, exact boundary admission/rejection, allocation caps, and preservation of forward measurements and margins.
- Windows tests for adapter identity, unavailable/invalid NVML data, external GPU memory pressure, and genuine allocation failures. Verify that the new policy still rejects oversized loads and does not turn errors into successful admission.
- Native Linux regression tests proving the existing query path and split decisions remain unchanged; compare cold load, peak memory, prefill, and decode. WSL2 is an additional WDDM-backed environment, not a substitute for native Linux evidence.
- Repeat Windows cold loads and almost-full 185k requests, followed by sustained cold/cached generation. Collect DXGI budget/usage and GPU residency/paging evidence alongside allocator and latency measurements. A large non-local usage counter alone is insufficient because CPU experts intentionally occupy host memory.
- Cover the supported allocator modes and single/multiple GPUs. Validate vision inference and MTP separately before extending claims to those workloads.

An alternative is to reduce real persistent memory or transient peaks while staying within the Windows process budget. That is a separate optimization project and may benefit Linux too. Reusing a scratch allocation does not automatically reduce its peak, and this probe does not justify lowering the measured transient or the 256 MiB margin.

## Repository validation and retained state

- Diagnostic TypeScript passed strict typechecking. The independent result verifier passed after all three load cases completed.
- `npm run typecheck` passed, including its `npm run lint` stage. No application runtime code changed, so an unrelated application test suite was not rerun. The relevant functional validation was the live loader/inference A/B and oversized-load rejection; upstream automated and native Linux tests remain outstanding.
- Both source and installed `model_ls.py` retained SHA-256 `40a75e864790540b201ca45c75928d9eaa4939c810edba16d8be66fa0c4ad229`; both `util/memory.py` copies retained `a29fb9504a37f50bb15f41c37bef03bebbd30612198c9242b724d9089fd31063`. The EXL3 source tree stayed clean.
- The diagnostic servers and monitors stopped, and the GPU returned to 0 MiB used / 24,138 MiB free. The saved preset was read on every launch and remained at 150,000 with its original settings.
- The intended additions are this report and its compact evidence JSON. Pre-existing changes and previous sessions' retained scratch were preserved. No commit or upstream publication was made.
- Automatic approval review rejected guarded removal of the session-owned `.siftkit/tmp/exl3-windows-budget-pr-20260921` directory with only **"blocked by policy"**. Its TypeScript probes, logs, responses, and verification output remain there. No alternative deletion was attempted.
