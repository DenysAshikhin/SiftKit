# EXL3 3.8_Next: MoE CPU-split decode scaling and prefill chunk-size sweep (2026-09-10)

Measured on the prod exl3 install (`C:\AI\exl3\prod`, exllamav3 1.4.8) with `src/eval/perf.py`
plus a small full-chunk prefill harness. MTP/spec-decode off in every run. RTX 4090 24 GB,
127 GB RAM, 24 logical cores (MoE CPU worker default = 12 threads, same as prod TabbyAPI).

## Preset under test

`server_model_presets_json` in `.siftkit/runtime.sqlite` → `app_config`, preset id `exl3-3-8-27b`,
label **EXL3 3.8_Next** (not the active preset; active is `exl3-3-8-27b-2` = 3.8_27B_5bpw).

| Field | Value |
|---|---|
| Model | `D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6` (101 GB on disk) |
| Arch | `qwen4_exp`, 48 layers (12 full-attn / 36 linear-attn), 512 routed experts, 10 active, PLE n-gram layer |
| NcpuMoe → `TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS` | **411** (411 coldest experts/layer on CPU, 101 on GPU) |
| UBatchSize → `chunk_size` | **4096** |
| NumCtx → `cache_size` | 185,500 → 185,600 |
| KvCacheQuantization | q8_0 → `cache_mode 8,8` |
| NgramRam | false (n-gram table streamed from disk per forward) |
| Speculative | mtp, draft 1, dynamic (disabled for these tests) |

perf.py equivalents: `-m <model> -cq 8 -mcs 411 -chunk_size 4096 -cs 185600`.

## 1. Is MoE CPU-split decode gain linear per expert?

**Short answer: roughly yes, ~0.05 tok/s per expert moved CPU→GPU, and it is small.**
Going from 1 GPU expert/layer to 128 GPU experts/layer buys ~7 tok/s (26.7 → 33.4) for
14 GB of VRAM. The CPU worker path is the floor, not the GPU.

Method: `perf.py --skip_prefill -cs 8192 -max_length 2048 -cq 8 -mcs N`, one fresh process per N
(dynamic hot/cold placement warms up inside the run's warmup pass). Small cache so VRAM goes to
experts and the split can go lower than prod allows. 100 decode tokens per context point.

| `-mcs` (CPU experts/layer) | GPU experts/layer | peak VRAM (MiB) | runs | decode tok/s, ctx 0–1024 (median) | ctx 1792 (median) |
|---|---|---|---|---|---|
| 512 | 0 | — | 1 | **load fails** (see note) | |
| 511 | 1 | 7,734 | 2 | 26.7 | 25.5 |
| 496 | 16 | 9,414 | 2 | 27.2 | 21.9 |
| 480 | 32 | 11,194 | 3 | 26.2 | 23.8 |
| 464 | 48 | 12,994 | 2 | 29.0 | 24.1 |
| 448 | 64 | 14,774 | 3 | 29.4 | 25.2 |
| 432 | 80 | 16,574 | 2 | 31.1 | 26.2 |
| 416 | 96 | 18,374 | 1 | 30.0 | 26.2 |
| **411 (prod)** | 101 | 18,954 | 1 | 31.9 | 25.6 |
| 400 | 112 | 20,154 | 2 | 30.7 | 25.2 |
| 384 | 128 | 21,954 | 3 | 33.4 | 29.1 |
| 352 / 320 | 160 / 192 | — | — | OOM at 8192 cache | |

- OLS fit over GPU experts/layer: **slope 0.051 tok/s per expert** (≈1.6 tok/s per 32 experts),
  intercept 26.1 tok/s. Linear within noise; no knee visible in 1..128.
- VRAM cost: **~112 MiB per expert slot** (one expert × 48 layers). 32 experts ≈ 3.5 GB.
- Run-to-run noise is ±2–3 tok/s at a fixed N (480 measured 29.2 / 25.5 / 23.7). One run
  (416 r2) stalled to 8 tok/s at ctx 0 with 190 s wall vs ~110 s normal and was excluded;
  likely a disk stall from the n-gram table being streamed per token (`NgramRam=false`).
- `-mcs 512` is not a valid data point: `block_sparse_mlp_cpu.py` requires
  `0 < split_k < num_experts`, so 512 silently disables the split and autosplit tries to fit the
  whole model → "Insufficient VRAM in split for model and cache".
- Decode is flat vs context: prod config measured 31.8 / 32.7 / 31.5 / 32.2 / 27.5 / 32.2 / 32.0 / 31.9
  tok/s at ctx 0 / 256 / 512 / 1k / 2k / 4k / 8k / 16k.

Prod headroom: at the real 185,600 cache the prod config peaks at **22,968 MiB**, ≈1.5 GB free,
so at most ~13 more experts could move to GPU ≈ +0.6 tok/s. Not worth the OOM risk.

## 2. Prefill throughput vs chunk size, 2048 → 4096 step 256

**Short answer: ~+70 tok/s per +256 chunk, near-linear, +42 % from 2048 to 4096. Keep 4096.**

Two measurements:

- **full-chunk harness** (the real answer): load once with `chunk_size 4096`, `-mcs 411`, `-cq 8`,
  prefill 16,384 wikitext tokens using only complete C-sized chunks (tail dropped), time each
  chunk with a CUDA sync, 2 reps in opposite order.
- **perf.py `--skip_gen -chunk_size C`**: separate process per C; reported here because its
  numbers are misleading for non-power-of-2 chunk sizes (explained below).

| chunk | full-chunk tok/s r1 | r2 | mean | vs 2048 | perf.py @16384 (ragged) | perf.py peak VRAM (MiB) |
|---|---|---|---|---|---|---|
| 2048 | 1336 | 1335 | 1336 | +0 % | 1330 | 19,588 |
| 2304 | 1371 | 1398 | 1385 | +4 % | 1326 | 19,692 |
| 2560 | 1488 | 1470 | 1479 | +11 % | 1329 | 19,754 |
| 2816 | 1560 | 1549 | 1555 | +16 % | 1447 | 19,834 |
| 3072 | 1634 | 1597 | 1616 | +21 % | 1433 | 19,914 |
| 3328 | 1678 | 1672 | 1675 | +25 % | 1444 | 20,016 |
| 3584 | 1746 | 1751 | 1748 | +31 % | 1441 | 20,098 |
| 3840 | 1808 | 1830 | 1819 | +36 % | 1459 | 20,158 |
| **4096 (prod)** | 1881 | 1909 | 1895 | +42 % | 1901 | 20,238 |

- Linear fit: **70 tok/s per +256 chunk**; no plateau by 4096, so larger chunks would likely
  keep gaining if VRAM allowed.
- VRAM cost of chunk size is tiny: ~80 MiB per +256 (2048→4096 = +650 MiB at cache 16384).
- perf.py's per-chunk-size numbers only agree at 2048 and 4096. It measures power-of-2 lengths,
  so e.g. chunk 3840 processes 8192 tokens as 3840 + 3840 + 512 and the 512-token tail
  (~450 tok/s) drags the average to ~1300. Use the full-chunk column.
- Small-chunk throughput for reference (perf.py, any chunk size): 256 → ~260 tok/s,
  512 → ~470, 1024 → ~850, 2048 → ~1340. Prefill of prompts shorter than the chunk size is
  bounded by the prompt length, not the chunk size.

## Takeaways

1. NcpuMoe is a VRAM knob, not a speed knob: each expert moved to GPU is worth ~0.05 tok/s
   and costs ~112 MiB. Prod's 411 is within ~1.5 GB of the ceiling at 185k context; leave it.
2. UBatchSize 4096 is the right setting; it is 42 % faster prefill than 2048 and every step in
   between is proportionally better. If VRAM ever frees up, larger chunks are a better use than
   more GPU experts for prefill-heavy workloads (repo-search / repo-agent).
3. Decode noise of ±3 tok/s across identical runs and one 8 tok/s stall point at the
   `NgramRam=false` disk streaming path as a variance source worth a separate look.

## Reproduction

Scratch harness lived in `.siftkit/tmp/perf-sweep/` (deleted). Commands:

```text
# decode sweep (one process per N)
python C:\AI\exl3\prod\src\eval\perf.py -m <model> -cq 8 -mcs N -cs 8192 -max_length 2048 --skip_prefill
# perf.py chunk sweep
python C:\AI\exl3\prod\src\eval\perf.py -m <model> -cq 8 -mcs 411 -cs 16384 -max_length 16384 -chunk_size C --skip_gen
# prod baseline
python C:\AI\exl3\prod\src\eval\perf.py -m <model> -cq 8 -mcs 411 -cs 185600 -max_length 16384 -chunk_size 4096
```

Env for all runs: `PYTORCH_ALLOC_CONF=PYTORCH_CUDA_ALLOC_CONF=backend:native,expandable_segments:True`
(matches `Exl3PresetAdapter.buildLaunchEnvironment`). Peak VRAM sampled from `nvidia-smi` at 1 Hz.
