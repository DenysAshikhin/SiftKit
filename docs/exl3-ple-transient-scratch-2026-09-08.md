# ExLlamaV3 PLE transient scratch allocations

Date: 2026-09-08
Environment: Windows 11, NVIDIA 24 GiB (23.99 GiB reported), TabbyAPI @ `92198cc`, ExLlamaV3 `deployment/pr341-pr346` (editable install at `pristine_exle/pr341-current-dev`), PyTorch 2.13.0+cu132, model `td_flash-next_4.05bpw_h6_ng6` (`qwen4_exp`)

Status: **diagnosed, not fixed.** No code changed. Needs a GPU A/B before any patch is proposed upstream.

## Summary

`PLELayer.forward_streams` allocates two large tensors with raw `torch.empty` on **every prefill chunk** and frees them at the end of the call. At the configured `chunk_size` of 2048 these are 80 MiB (fp32) and ~40 MiB (fp16). Every other hot scratch path in ExLlamaV3 routes through `g_tensor_cache`; `ple.py` uses it zero times.

This is churn, not a leak — peak VRAM is unchanged and the buffers are correctly released. But repeatedly requesting an 80 MiB *contiguous* block against a nearly-full pool is precisely the allocation that fails when the pool is fragmented, and it is the allocation that took down a repo-search run on 2026-09-08.

## Evidence

The failure, from `TabbyAPI/logs/2026-09-08_20-44-16_955085.log`, request #162 at 20:52:59, after ~160 successful requests on the same process:

```
CUDA out of memory. Tried to allocate 80.00 MiB. GPU 0 has a total capacity of 23.99 GiB
of which 0 bytes is free. Of the allocated memory 22.40 GiB is allocated by PyTorch,
and 562.08 MiB is reserved by PyTorch but unallocated.
```

Traceback tail:

```
exllamav3/generator/generator.py:527   in iterate           -> job.prefill(results)
exllamav3/generator/job.py:1372        in prefill           -> model.forward(...)
exllamav3/model/model_ls.py:306        in forward_ls        -> module.forward(x, params)
exllamav3/modules/ple.py:377           in forward           -> self.forward_streams(...)
exllamav3/modules/ple.py:278           in forward_streams   -> ext.ple_forward_streams(...)
torch.OutOfMemoryError
```

The allocation size identifies the tensor exactly. From the model's `text_config`:

```
hc_count (4) * hidden_size (2560) = 10,240
80 MiB / 4 bytes / 10,240          = 2,048 tokens  == the configured chunk_size
```

So the 80 MiB is `delta`, and the arithmetic closes with no free parameters.

Server recovered afterwards — requests #163 onward succeeded. That rules out a monotonic leak and is consistent with a transient spike against a full, fragmented pool.

## The code

[`ple.py:275-277`](../pristine_exle/pr341-current-dev/exllamav3/modules/ple.py#L275-L277), allocated fresh per chunk:

```python
delta = torch.empty_like(streams)                       # (bsz, seq, hc_mult, hidden) fp32
conv_stream = torch.empty((bsz, H * D, self.conv_state_len + seq),
                          dtype = torch.half, device = streams.device)
ext.ple_forward_streams(streams, emb.contiguous(), ..., delta, conv_stream)
```

Per prefill chunk at `chunk_size = 2048`:

| Tensor | Shape | Dtype | Size | Per token |
|---|---|---|---:|---:|
| `delta` | `(1, 2048, 4, 2560)` | fp32 | 80 MiB | 40 KiB |
| `conv_stream` | `(1, 10240, conv_state_len + 2048)` | fp16 | ~40 MiB | 20 KiB |
| | | | **~120 MiB** | **60 KiB** |

Plus `emb.contiguous()` and the `x + delta` output tensor, both smaller.

Both large buffers are consumed inside the same call and never retained — [`ple.py:377-389`](../pristine_exle/pr341-current-dev/exllamav3/modules/ple.py#L377-L389) copies `conv_stream` into `conv_state` in the slot loop and returns `x + delta`. PLE runs once per forward pass, at the front. **Reuse is therefore safe.**

## Why this reads as an oversight, not a design choice

- The codebase convention is explicit: upstream commit `7e299a9` "GatedResidual: Route scratch allocations through g_tensor_cache (bucketed, shared per device)".
- `grep -c g_tensor_cache exllamav3/modules/ple.py` → **0**.
- PLE is new (`5d18789` "Add NGramEmbedding and recurrent PLELayer modules (Qwen4Exp)", then `4d881c7`), so it predates nothing — it simply was never converted.
- This is **upstream `dev` code**, untouched by the local PR341/PR346 work, and none of the 4 commits this tree is behind `origin/dev` touch `ple.py`. A fix belongs upstream, not in the deployment branch.

## Proposed fix

Route both buffers through the bucketed scratch cache, sized by the flat element count and sliced/viewed to shape — the pattern already used for `bca_po` / `bca_ml` in `bc_attn.py`.

**Critical detail: must use `get_bucketed`, not `get`.** `GTensorCache.get` keys on exact shape and never evicts — `drop` is commented out at `util/tensor.py:240-246`, leaving only `drop_all` on unload. The final chunk of any prefill is a remainder length, so naive `get` would ratchet a new permanent buffer per distinct `seq` and make fragmentation strictly worse. `get_bucketed` rounds to the next power of two; `chunk_size` 2048 is already a power of two, so retained size equals the existing peak.

## Expected impact

| Dimension | Effect |
|---|---|
| VRAM saved | **~0.** A full-chunk prefill needs these bytes either way. |
| Steady-state retention | +~120 MiB held permanently, bounded by `chunk_size` — equal to the current peak, so no regression against peak. |
| Failure mode | Removes the recurring large contiguous request that OOM'd. This is a stability fix, not a savings fix. |
| Latency | Should remove periodic stalls: when a large alloc cannot be served, PyTorch releases cached blocks and retries (a synchronizing `cudaFree` storm). Suspected contributor to throughput variance; **not measured**. |

## Related: why there is no allocator safety net on this box

These interact, and the timing matters.

- TabbyAPI `076c202` (2026-09-07 02:48) — "Config: Set cudaMallocAsync backend off by default" — flipped `cuda_malloc_async` from `True` to `False`. Its stated rationale: "unless PYTORCH_CUDA_ALLOC_CONF is set, ExLlamaV3 enables expandable segments in Torch's native allocator, which performs better than cudaMallocAsync."
- That rationale does not hold on Windows. ExLlamaV3 deliberately skips expandable segments on win32 (`exllamav3/__init__.py:27`), and PyTorch's Windows build compiles the feature out entirely — `c10_cuda.dll` contains the string `expandable_segments not supported on this platform`, which only compiles in when `PYTORCH_C10_DRIVER_API_SUPPORTED` is undefined.
- The OOM occurred 2026-09-08, ~42 hours after that default flip. The operator's `config.yml` does not set `cuda_malloc_async`, so it took the new default.
- The earlier [deep-context VRAM investigation](exl3-deep-context-vram-investigation-2026-09-03.md) measured, on this same box, that the native allocator could not even load the 155k preset ("Insufficient VRAM in split") while the async allocator could.

So this machine silently moved from `cudaMallocAsync` to the plain native allocator, on the one platform where the intended replacement does not exist. Setting `cuda_malloc_async: true` in `config.yml` restores prior behaviour and is independent of the PLE fix.

## Open questions / validation plan

1. GPU A/B of the bucketed-scratch patch: prefill peak, reserved-vs-allocated split, and whether the 562 MiB stranded slack shrinks. Not runnable in a code-only session.
2. Confirm no model configuration instantiates more than one `PLELayer`, or that two instances cannot be live concurrently, before sharing a tag.
3. Measure whether the allocator-release stall is real, by watching for `cudaFree`-induced latency spikes around large prefills.
4. Decide the same treatment for `emb.contiguous()` and the `x + delta` output if the A/B shows they matter.
5. Independent of this: `chunk_size` is a linear lever — halving it to 1024 halves both transients (40 MiB + ~20 MiB) at a prefill-throughput cost. `chunk_size` comes from `preset.UBatchSize` via [`exl3-preset-adapter.ts:93`](../src/inference-presets/exl3-preset-adapter.ts#L93).

## Secondary finding (not implicated in this failure)

`GTensorCache.get` keys on exact shape and never evicts, while the decode warmup at [`attn.py:859-863`](../pristine_exle/pr341-current-dev/exllamav3/modules/attn.py#L859-L863) states "Backings are bucketed and shared across slots and layers, so configuring the largest and smallest shapes bounds the whole family". Eight `bca_*` tags in `bc_attn.py::_configure` use exact-shape `get` with shapes derived from `bsz` / `q_len` / `R`, so distinct slot shapes ratchet permanently. Bounded in this deployment and absent from the traceback, but it contradicts the stated invariant and is worth a separate look.
