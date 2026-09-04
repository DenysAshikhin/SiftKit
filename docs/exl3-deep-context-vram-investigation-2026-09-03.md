# ExLlamaV3 deep-context VRAM investigation

Date: 2026-09-03  
Environment: Windows, NVIDIA RTX 4090 24 GiB, TabbyAPI, ExLlamaV3 1.4.6, PyTorch 2.13.0+cu132

## Conclusion

The central diagnosis is correct:

> The 155k preset leaves enough VRAM to load but not enough to execute a deep prefill. TabbyAPI mostly passes through that configuration; ExLlamaV3 creates the runtime allocation pressure; PyTorch/CUDA retains the freed backing memory.

Two parts need correction:

1. ExLlamaV3 already has a shared Q8 attention staging buffer.
2. "A pool full of wrongly sized holes" is plausible, but the available measurements do not directly prove the pool's internal fragmentation layout.

## Controlled evidence

| Configuration | Prompt | After load | Prefill peak | Result |
|---|---:|---:|---:|---|
| 155k, async | 81,390 | 22,980 MiB used; 1,159 MiB free | 23,980 MiB used; 159 MiB free | OOM |
| 155k, async, no arena | 81,075 | 22,980 MiB used; 1,159 MiB free | 24,044 MiB used; 95 MiB free | OOM |
| 120k, async | 117,878 | 21,764 MiB used; 2,375 MiB free | 22,818 MiB used; 1,321 MiB free | Success |
| 120k, native | 117,878 | 21,902 MiB used; 2,237 MiB free | 22,828 MiB used; 1,311 MiB free | Success |

Local evidence:

- [155k baseline probe](C:/tmp/rsx/oomcheck/probe-base-plain.json)
- [155k no-arena probe](C:/tmp/rsx/oomcheck/probe-noarena155-81k.json)
- [120k async probe](C:/tmp/rsx/oomcheck/probe-async120-118k.json)
- [120k native probe](C:/tmp/rsx/oomcheck/probe-native120-118k.json)
- [155k successful load and subsequent OOM](C:/tmp/rsx/oomcheck/tabby-noarena155.out.log)

The clearest 155k run:

- Loaded successfully.
- Failed during prefill with 22.11 GiB of live allocation.
- Requested exactly 170 MiB.
- CUDA reported zero free bytes against a 23.99 GiB device limit.
- The stack ended in ExLlamaV3's `reconstruct_hgemm`.

This proves the operational failure:

- Loading with 1.1 GiB of NVML headroom is insufficient.
- Prefill grows board usage by approximately 1.0-1.064 GiB.
- The subsequent 170 MiB reconstruction allocation cannot be satisfied.
- Reducing the cache to 120k allows a substantially deeper 117,878-token prompt to complete under either allocator.

Native allocation at 155k failed during model/cache loading with `Insufficient VRAM in split`, so its cache-release behavior cannot practically rescue that configuration.

## Ownership

| Memory or behavior | Actual owner | Verdict |
|---|---|---|
| 426 MiB NVML reserved | NVIDIA driver, WDDM, and device | Verified on this RTX 4090; not meaningfully application-fixable |
| CUDA context, kernels, and libraries | CUDA/PyTorch process | A 230-500 MiB estimate is plausible but was not separately measured here |
| Model, Q8 cache, MTP, and configured context | Preset determines sizes; ExLlamaV3 materializes them | Immediate sizing responsibility belongs to SiftKit |
| Temporary reconstruction and output tensors | ExLlamaV3 | Primary runtime allocation owner |
| Retention of freed backing memory | PyTorch async allocator and CUDA mempool policy | Important amplifier |
| Allocator selection and load wiring | TabbyAPI | Secondary responsibility |

SiftKit passes its sizes directly in [`exl3-preset-adapter.ts`](../src/inference-presets/exl3-preset-adapter.ts):

```text
max_seq_len = preset.NumCtx
cache_size = ceil(NumCtx / 256) * 256
chunk_size = preset.UBatchSize
```

Historical run records confirm that 155,000/155,136 was actually used. The currently active stored preset has since been reduced to 145,000; that value has not yet been proven safe by an equivalent clean deep-context run.

## TabbyAPI's role

TabbyAPI:

- Defaults `cuda_malloc_async` to enabled.
- Sets `PYTORCH_ALLOC_CONF=backend:cudaMallocAsync`.
- Accepts and uses the configured `max_seq_len`, `cache_size`, and chunk size.
- Only clamps sequence length when it exceeds cache capacity.

Sources:

- [TabbyAPI startup](https://github.com/theroyallab/tabbyAPI/blob/main/main.py)
- [TabbyAPI configuration schema](https://github.com/theroyallab/tabbyAPI/blob/main/common/config_models.py)
- [TabbyAPI ExLlamaV3 model loader](https://github.com/theroyallab/tabbyAPI/blob/main/backends/exllamav3/model.py)

Therefore, "TabbyAPI's share is small" is fair. Async allocation is a reasonable default because native could not load 155k and showed essentially identical peak use and performance at 120k.

TabbyAPI could add safeguards or allocator-recovery hooks, but it does not originate the unsafe 155k capacity decision.

## ExLlamaV3 reconstruction allocations

The model dimensions are:

- Hidden size: 5,120
- MLP intermediate size: 17,408
- Reconstruction type: FP16

One reconstructed matrix therefore requires:

```text
5,120 * 17,408 * 2 bytes
= 178,257,920 bytes
= 170 MiB
```

That exactly matches the failed allocation.

ExLlamaV3 reconstructs the MLP gate, up, and down projections sequentially for long-input execution. Thus "three 170 MiB allocations per layer" is supported as allocation churn, but it should not be read as three simultaneous 170 MiB live matrices.

Source: [ExLlamaV3 EXL3 reconstruction code](https://github.com/turboderp-org/exllamav3/blob/dev/exllamav3/modules/quant/exl3.py).

A persistent 170 MiB reconstruction workspace is consequently a credible upstream improvement. It needs an A/B implementation test: keeping it live only helps if it prevents more pool growth than the added permanent allocation costs.

## Correction: attention staging already exists

ExLlamaV3's default `EXL3_QC_STAGING=1` already:

- Dequantizes Q8 cache into shared FP16 staging storage.
- Shares that storage across layers on a device.
- Sizes it for the configured cache during autosplit measurement.

The documented formula is:

```text
2 * maximum_tokens * KV_heads * head_dimension FP16 elements
```

For this model:

```text
2 * 155,136 * 4 * 256 * 2 bytes = 606 MiB
```

Source: [ExLlamaV3 environment-variable documentation](https://github.com/turboderp-org/exllamav3/blob/master/doc/env_vars.md).

Therefore:

```text
606 MiB attention staging
+ 170 MiB reconstruction matrix
= 776 MiB
```

That is already a lower bound before activations, outputs, Gated DeltaNet workspaces, and smaller temporaries. A claimed flat working set of "roughly 200-400 MiB" is not credible under the current Q8 staging mode.

Disabling staging with `EXL3_QC_STAGING=0` would remove that 606 MiB requirement, but ExLlamaV3 documents an approximately 5-25% attention-prefill performance penalty.

There is also a lifecycle issue: the loader calls `empty_cache()` and then drops the global tensor cache. Dynamic shared tensors released after the trim can remain as allocator backing and later be recreated during the real request. Reordering that lifecycle, or recreating stable runtime workspaces before a final trim, is a more precise upstream target than merely adding an attention scratch buffer.

## PyTorch and CUDA contribution

The installed PyTorch version is `2.13.0+cu132`.

Its `cudaMallocAsync` implementation:

- Sets the default CUDA mempool release threshold to `UINT64_MAX`.
- Therefore retains freed backing memory rather than routinely returning it to the driver.
- Does not trim and retry on allocation failure in the installed v2.13 implementation.
- Trims the pool when `torch.cuda.empty_cache()` is explicitly executed.

Sources:

- [PyTorch 2.13 async allocator](https://github.com/pytorch/pytorch/blob/v2.13.0/c10/cuda/CUDAMallocAsyncAllocator.cpp)
- [NVIDIA async-pool API](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__MALLOC__ASYNC.html)

This validates the "never-release pool" part operationally. Newer PyTorch development code contains stronger trim/retry handling, but that behavior is not present in this installation and should not be relied upon until an applicable release is installed and tested.

Native allocator mitigations are not a current solution:

- `expandable_segments` is not viable in the tested Windows environment.
- Native failed to load the 155k model/cache combination.
- At 120k, native and async differed by only 10 MiB at peak and approximately 0.7 seconds overall.

## Strength of the fragmentation claim

### Proven

- Temporary allocations are created and freed repeatedly.
- Async pool backing remains resident.
- Board use grows by roughly one gigabyte during prefill.
- PyTorch reports only 22.11 GiB actively allocated when the 23.99 GiB device cannot provide another 170 MiB.
- A smaller cache makes the same allocation pattern succeed.

### Strong inference

- Freed pool backing is not reusable in the size or order needed by subsequent allocations, or is unavailable because of stream-ordering dependencies.
- ExLlamaV3's allocation ordering and cache-dropping lifecycle cause avoidable pool expansion.

### Not directly proven

- The exact number and sizes of allocator holes.
- That conventional fragmentation, rather than pending stream-reuse constraints or another retained workspace, accounts for every unavailable byte.
- That a persistent reconstruction tensor alone reduces runtime growth to a particular number.

Calling it "a pool full of wrongly sized holes" is therefore a good working hypothesis, not yet a demonstrated allocator trace. Proving that exact statement would require CUDA mempool used/reserved telemetry or an allocator snapshot at each chunk or layer, followed by an A/B persistent-workspace patch.

## Recommended wording

> The 155k SiftKit preset is oversized for reliable deep-prefill execution on this 24 GiB Windows configuration. It loads with only about 1.1 GiB free, while real prefill increases the CUDA pool's board footprint by approximately 1.0 GiB and then requires another 170 MiB EXL3 reconstruction allocation. TabbyAPI primarily passes through the requested sizes and selects its normal async allocator. ExLlamaV3 owns the allocation pattern; PyTorch/CUDA's retained async pool amplifies it. SiftKit owns the immediate capacity fix, while ExLlamaV3 is the realistic upstream location for making runtime workspace allocation stable.

## Recommended actions

1. Keep the preset below the measured unsafe capacity and require a deep-context prefill margin, not merely successful loading. A 120k cache is proven; 145k is not yet proven.
2. In ExLlamaV3, A/B test one persistent 170 MiB reconstruction workspace.
3. Preserve or recreate runtime shared workspaces before the loader's final allocator trim instead of dropping them afterward.
4. Instrument CUDA mempool used and reserved bytes to distinguish fragmentation from stream-ordering retention.
5. Evaluate a newer PyTorch trim-on-OOM implementation when released for this environment.
6. Treat `EXL3_QC_STAGING=0` as a memory/performance tradeoff, not a free fix.

## Investigation scope

- No SiftKit commands were used.
- No implementation files were changed.
- The existing active inference process was not interrupted.
- The conclusions distinguish direct measurements from inference and unproven hypotheses.
