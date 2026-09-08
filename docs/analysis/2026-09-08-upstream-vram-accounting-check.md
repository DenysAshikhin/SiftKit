# Upstream VRAM accounting check — September 8, 2026

## Finding

The reproduced Next MoE startup failure at 410 CPU experts is triggered by the new loader headroom check. Its controlling 540.38 MiB allocation is genuinely temporary, and the earlier cumulative-budget double-count fix remains present. **However, a subsequent ownership probe confirmed a separate streamed-vision defect: stale native MLP handles retain 193.64 MiB of original GPU weights after host offloading.** The initial conclusion that the approximately 200 MiB vision cost was ordinary resident overhead was too broad.

The earlier estimate of roughly 700 MiB described GPU weight memory freed by changing 410 to 416 CPU experts per layer. It was not a measured upstream memory increase. The traced shortfall was only 116.61 MiB. Values 411–415 were not tested, so 416 is a verified working configuration, not an established minimum.

## Method

The production model was temporarily unloaded through the managed API. Separate Python processes ran the installed, unchanged upstream Tabby and EXL3 source with the actual Next preset, overriding only the diagnostic CPU expert count to 410 and comparing streamed vision with vision disabled. The saved production configuration was never changed.

Python's tracing API recorded the loader's own local values before its new comparison, along with CUDA allocated, peak and reserved counters. It also recorded new shared scratch allocations, component boundaries, pinned host weight storage, and the original exception before the loader reduced it to `Insufficient VRAM`. No loader checks were bypassed and no source or native binary was modified.

The vision-disabled process deliberately exited after successful model loading; this was an allocation test, not an inference test. The active production model was restored afterward. A configuration readback matched the pre-diagnostic snapshot exactly, and the managed runtime reported ready.

## Measured rejection

Model: `td_flash-next_4.05bpw_h6_ng6`; context 155000; FP16 KV; chunk size 2048; one slot; MTP disabled; 410 CPU experts per layer.

| At final output-layer check | Vision streamed | Vision disabled |
|---|---:|---:|
| Live CUDA allocation | 22418.23 MiB | 22217.90 MiB |
| Loader budget | 22842.00 MiB | 22864.00 MiB |
| Remaining budget | 423.77 MiB | 646.10 MiB |
| Largest measured temporary allocation | 540.38 MiB | 540.38 MiB |
| Margin after required temporary allocation | **−116.61 MiB** | **+105.72 MiB** |
| Result | New headroom check rejected | Loaded |

The controlling operation was `model.language_model.layers.1.ple`, the per-layer n-gram embedding step. With streamed vision:

- Before its forward: 874625536 bytes allocated.
- Peak: 1441257984 bytes allocated.
- After its forward: 874625536 bytes allocated.
- Increment: 566632448 bytes = 540.3828125 MiB.
- New retained shared scratch allocations: none.

The identical before/after allocation rules out treating this particular peak as retained storage. The same 540.38 MiB increment occurred with vision disabled. This embedding implementation is unchanged between the former customized production branch and the selected upstream revision.

## Vision accounting

### Confirmed stale GPU weights

An additional isolated probe stopped before loading the text component, walked live CUDA tensor storages, and matched their pointers against active PyTorch allocator blocks. This distinguishes actual GPU storage from CUDA aliases backed by pinned host RAM. It found 54 original GPU trellis tensors, each 3760128 bytes, alongside the streamed host aliases.

`MLP.load_local()` creates `BC_MLP` before `Module.pin_linears()` offloads its children. `Linear.pin_linears()` replaces each child's native linear handle, but the parent `BC_MLP` still owns the old handles through C++ shared pointers. Those handles retain the original GPU trellis tensors. The small-tensor explanation therefore does not account for most of the observed vision cost.

In this disposable process only, calling the existing `MLP.load_local()` for all 27 vision MLPs rebuilt their native handles against the already-pinned linears. Live allocation fell from 223074816 to 20027904 bytes: **203046912 bytes / 193.640625 MiB freed**. The 319.78 MiB of pinned host aliases remained unchanged. This is an allocation-retention defect, rather than a second mathematical charge in the budget formula. The old and current branches have identical `modules/mlp.py`, so this evidence does not establish that the sync introduced it.

The approximately 200.33 MiB vision-versus-disabled delta was measured later in the text load; 193.64 MiB of it is explained by these stale weights. The configured explicit reserve is independently 96 MiB. The remaining few MiB are not fully reconciled by this probe.

No production source or preset was changed. The active model was restored and the configuration matched the pre-probe snapshot. This was a memory-ownership experiment, not a tested production fix or inference validation. Evidence: [before/after storage ownership](2026-09-08-vision-stale-weight-evidence.json).

### Budget arithmetic

Streamed vision is partly host-resident. The implementation moves bulk linear weight storage to pinned host memory and uses CUDA aliases; smaller tensors and other GPU allocations remain resident. The trace observed 319.78 MiB of pinned host weight storage. By the final text-model check, streamed vision added approximately 200.33 MiB of live CUDA allocation compared with disabling it.

The cumulative allocation budget uses:

```text
budget = already_reserved_by_this_process + driver_free_memory − explicit_reserve
```

The main load added back 244 MiB already reserved by the process when vision was enabled. This prevents the earlier component's allocation from being deducted a second time. The resulting budget was only 22 MiB lower than the vision-disabled budget; its approximately 200 MiB of live CUDA storage was counted on the allocation side once. The main model's `max_transient` dictionary is also freshly initialized for that component, so the vision component's transient maximum is not carried into it.

## Upstream change and limits

Upstream commit `9d771c9` added tracking of the largest forward-pass peak and this comparison in `exllamav3/model/model_ls.py`:

```text
current_allocated + largest_measured_transient > device_budget
```

The old loader could finish adding weights after an earlier layer had passed its own forward, without preserving enough space to run that earlier layer again. The new check explicitly protects that headroom. In this reproduction it triggered the specific `autosplit ... largest transient ... (540 MiB)` error at `lm_head`; the final layer's allocation itself had succeeded.

The formula can be conservative for other operations that retain newly allocated buffers: one measured layer retained approximately 39 MiB of new shared scratch, which is included in that layer's peak increase. Its total increment was below the 540.38 MiB controlling peak, so it did not determine this failure. These measurements are not a proof that every architecture or allocation pattern is counted optimally.

Evidence: [captured allocator values](2026-09-08-upstream-vram-accounting-evidence.json). Production source remained pristine during these probes and the original active 4.9bpw model was restored. At closeout, the user explicitly retained the previously tested 416 CPU experts for Next and assigned the stale vision-weight fix and upstream PR to another agent. No production fix is included in this task.
