# Qwen3.8 Flash-Next engine: what was tried, what stuck (2026-09-02 to 2026-09-05)

> Historical record. Deployment, dependency pins, and model lifecycle instructions here are superseded by [the current upstream setup](../exl3-backend-setup.md). Experimental engine results are retained for comparison only.

Single record of the Flash-Next performance work. Supersedes the per-session handoffs and the raw
run outputs, which were deleted on 2026-09-05 (recoverable from SiftKit commit `523f152f`).
Reusable tooling lives in [`qwen38-flash-next-engine/`](qwen38-flash-next-engine/).

**Bottom line.** The saved 155k preset went from 111 prefill / 19 decode tok/s on the old engine
to 1,222 / 32-33 on the merged zero-copy engine. At the 32k-cache, 4096-chunk benchmark shape the
merged engine does 1,987 prefill / 32-34 decode versus 1,147 / 25-28 for pure upstream v1.4.7.
The merged engine is numerically equivalent to the old one within the old engine's own
nondeterminism. It is committed as `58d19c0` on branch `engine-zero-copy` in
`pristine_exle/exllamav3` and is not yet in production.

## Setup

- RTX 4090 24 GiB, WDDM, driver 610.47, PCIe 4.0 x16, 360 W limit. Ryzen 9 7900X (12c/24t),
  128 GiB DDR5-5600 dual channel (89.6 GB/s theoretical). Ultimate Performance power plan.
- Model `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`: `Qwen4ExpForConditionalGeneration`,
  48 layers, 512 routed experts, top-10, n-gram table 6. Engine reports 4.29 bpw / 6.01 head.
- Saved SiftKit preset `EXL3 3.8_Next` (`exl3-3-8-27b`): FP16 KV, 155000 context / 155136 cache,
  chunk 2048, 410 CPU experts per layer, MTP off, vision offloaded to host RAM. Tabby launches
  with `PYTORCH_ALLOC_CONF=backend:cudaMallocAsync`.
- Python `C:/envs/rl313-turbo/Scripts/python.exe` (3.13.14, torch 2.13.0+cu132). Production
  (SiftKit-managed Tabby) imports `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench`
  via the editable install, still the old engine. Benchmarks used
  `PYTHONPATH=pristine_exle/exllamav3` so the in-place `.pyd` shadows site-packages.
- Benchmark: `eval/perf.py`, warmup on. `-max_length` changes token offsets, so runs with
  different values are not the same workload. Two shapes were used: the saved preset
  (`-mcs 410 -mct 12 -cs 155136 -chunk_size 2048`, no `-ngr`, cudaMallocAsync) and the fast
  shape (`-cs 32768 -chunk_size 4096 -ngr -max_length 8192`, native allocator).

## Levers, with verdict

Prefill numbers are tok/s at 8192 tokens; decode is tok/s at the stated context.

### Kept (in `58d19c0` or already upstream)

| Lever | Evidence | Verdict |
|---|---|---|
| Zero-copy expert DMA from a page-locked shared-memory arena, GPU un-swizzle raw slot to compute slot, stager thread and pinned staging ring removed | Old engine best 946 with every knob tuned; new engine 1,815-1,897 on f3f7e42, 1,987 merged. Stream profile: copy-stream wait on the CPU stager fell from 43 ms to 0.04 ms per layer; the stream is now PCIe-bound (26-30 ms DMA per ~1 GB layer, 33-37 GB/s). | Keep. This is the prefill win. Host memcpy from the arena tops out at 11-18 GB/s (`stagebench`), so any staging design caps near 10-13 GB/s. |
| Band-unit GEMV partition in `moe_mul1.cpp` (8-tile contiguous units per worker) | Bit-exact against the old kernel (`moe_cpu_ref.py --check`). Merged decode 32-34 vs upstream memops-off 30-32. | Keep, about +5% decode, no cost. |
| `EXL3_MOE_MEMOPS=0` as the Windows default | On old engine 24-26 to 28-30 (d0/d5 vs d3/d4/d7). On pure upstream 25-28 to 30-32 (u1/u2 vs u3/u4). Independent of every other lever. | Keep. Engine default rather than a launch variable because SiftKit's managed launch has no free-form engine env field. |
| Bandwidth probe: 250 ms link warm-up then best-of-8 | Idle link sits at Gen1; the old two-copy probe read 3.4-6.8 GB/s and set `stream_t` 58, halving prefill (901 to 414). Warmed probe reads 26.3-26.7 GB/s. | Keep. Upstream cbdd9d3 adopted the same probe. |
| `EXL3_MOE_STREAM_T` default 8 (upstream) | Merged engine b1 (8) 1,987 vs b2/b3 (4) 1,920/1,701. On the old engine 4 beat 16 (1,098 vs 994) because the CPU tail serialized ahead of streamed batches. | Keep upstream's default. Do not force 4 any more. |
| CPU worker child exits via `os._exit(0)` | Arena chunks stay exported for the process lifetime; normal teardown printed 46 `BufferError` warnings per run. | Keep. |
| Upstream v1.4.7 work: AVX2 bytesum accumulate, VNNI/VBMI prefetch, pool dispatch race fix, threshold sqrt scaling, `moe_unswizzle_trellis` kernel | All in the merged build and exercised by b1-b3. The local un-swizzle kernel was dropped in favour of upstream's. | Keep. |

### Dropped or neutral

| Lever | Evidence | Verdict |
|---|---|---|
| Stream threshold 1 | Sept 4, old engine, 155k preset: 111 to 487-489 (4.4x). New engine: p3 852 vs p1 905, and 8 beats 4. | Superseded. Was the right fix for the old probe bug; wrong on the new engine. |
| VRAM slot count and size (2x vs 4x 64 MB) | New engine n1 1,815 vs n3 1,841, within noise. | Neutral. Leave defaults. |
| Swizzle off | Old engine prefill +4% (941 vs 905), decode worse (27.4/26.9 vs 28.5/29.5). | Drop. Swizzle stays on. |
| Stage thread count 1/4/8/12 | 735 / 890 / 905 / 935 old engine. | Moot. Stager removed. |
| Fused-kernel cap 0 / 32 / 128 | 409 / 681 / 898 vs 905 uncapped. | Drop. |
| Decode threads 18 / 24 | 13.7 / 2.6 tok/s vs 26 at 12 (SMT oversubscription). | Keep 12 (`-mct 12`). |
| 6 compute threads, 8 compute threads, pool unpinned | 92 (Sept 4), 934, 946: within noise or worse. | Neutral. |
| Embeddings in RAM (`-ngr`) | +4-5% prefill; costs 36 GiB host RAM. The n-gram row gather blocks layer 1 instead of overlapping layer 0; the fix (start the gather on a worker thread at forward start) was proposed, not implemented. | Optional. Preset keeps SSD embeddings. |
| Chunk 4096 at the 155k preset | Load fails `Insufficient VRAM in split for model and cache` on both engines (22.8 GB used at failure). | Impossible on 24 GiB. Preset keeps 2048. |
| Native vs cudaMallocAsync allocator | Never isolated; every A/B also changed cache or chunk. m1 used cudaMallocAsync and hit the numbers above. | Unresolved, low priority. |

## Final numbers

Prefill tok/s at 256 / 2048 / 4096 / 8192, decode tok/s at context 0 / 1024 / 4096 / 7936. All
runs exit 0, empty stderr, 12 threads.

| Run | Engine | Shape | Prefill | Decode |
|---|---|---|---|---|
| Sept 4 reference | old f3f7e42, auto probe | 155k preset | 78 / 81 / 96 / 111 | 19.2 (ctx 1024) / 20.8 (ctx 7936) |
| Sept 4 tuned | old, `STREAM_T=1` | 155k preset | 489 at 8192 | 18.5-19.7 |
| u1 | upstream c93f3c6 (v1.4.7), defaults | 32k / 4096 / `-ngr` | 149 / 576 / 1133 / 1147 | 27.9 / 27.1 / 27.8 / 27.9 |
| u3 | upstream, `MEMOPS=0` | same | 102 / 616 / 1036 / 1060 | 31.8 / 31.9 / 29.8 / 31.2 |
| b1 | merged 58d19c0, defaults | same | 276 / 1247 / 1911 / 1987 | 28.5 / 32.9 / 31.8 / 32.7 |
| b3 | merged, `STREAM_T=4` | same | 307 / 1198 / 1843 / 1701 | 33.1 / 27.7 / 32.7 / 34.2 |
| m1 | local engine on f3f7e42 | 155k preset | 316 / 1172 / 1199 / 1222 | 28.3 / 33.0 / 28.1 / 33.0 |
| p1 | production build, run 1 | same | 172 / 915 / 1536 / 1550 | 32.8 / 34.1 / 33.2 / 33.5 |
| p2 | production build, run 2 (Tabby smoke boots overlapped) | same | 224 / 1146 / 1912 / 1942 | 26.4 / 15.6 / 28.7 / 27.7 |
| p3 | production build, run 3 (clean) | same | 243 / 1110 / 1897 / 1949 | 32.8 / 31.2 / 32.1 / 30.9 |

Production rows p1-p3 are the installed `1.4.7+unified.1` build on the production import path (`docs/analysis/qwen38-flash-next-engine/production-merged-perf*.txt`). Every run, old and new, dips at one context point around 1792-2048. Merged decode shows more
run-to-run spread than the f3f7e42 build (b2 was an outlier at 16-25 with no external load in
telemetry); not attributed. If it recurs, compare `EXL3_MOE_CPU_PROF` phase times between
58d19c0 and f3f7e42 before blaming the rebase. Peak VRAM at the 155k preset: 23.6 GB.

**Equivalence.** `logits_check.py`, 2048-token streamed prefill plus 24 greedy steps,
`-mcs 410 -mct 12 -cs 32768`, threshold 4. The old engine is nondeterministic (atomic scatter-adds
in the fused MoE kernel, dynamic expert placement), so old-vs-old is the noise floor.

| Pair | Greedy agreement | First-step max abs diff | Mean abs diff | Argmax equal |
|---|---:|---:|---:|---|
| old vs old2 (noise floor) | 5/24 | 1.156 | 0.126 | yes |
| merged vs old | 5/24 | 0.378 | 0.055 | yes |
| merged vs old2 | 4/24 | 1.214 | 0.129 | yes |

Merged differs from old by no more than old differs from itself. Tests on the merged build:
`tests/test_moe_cpu_offload.py` plus `tests/test_moe_cpu_pool_.py`, 4 passed.

## Ceiling model

Per expert 3 x 819,200 B; 410 CPU experts x 48 layers = 48.4 GB per fully streamed 4096-token
chunk. PCIe pinned-to-device measured 26.7 GB/s, so prefill is capped near 2,200 tok/s at chunk
4096 and the merged engine is already at 1,900-2,000. Decode per layer: 0.47 ms worker compute,
0.27 ms GPU critical path, about 7.7 CPU experts per token per layer at 41 GB/s effective; a
purely bandwidth-bound CPU path would allow about 80 tok/s, realistic mid-30s without streaming
experts during decode. The old 2k prefill / 50 decode targets were subsystem estimates, not
end-to-end ceilings.

## Reproduce

Fresh shell. `PYTHONPATH` must point at the checkout under test; the editable install points at
the old engine otherwise.

```bash
# 32k benchmark shape, writes <name>.txt/-env/-status/-gpu.csv/-cpu.csv next to the script's EV dir
docs/analysis/qwen38-flash-next-engine/scripts/run5.sh b1 "" \
  -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192
# whole comparison chains
docs/analysis/qwen38-flash-next-engine/scripts/sweep-merged.sh
docs/analysis/qwen38-flash-next-engine/scripts/sweep-upstream.sh
# logits equivalence against the saved old-engine references
docs/analysis/qwen38-flash-next-engine/scripts/logits_merged.sh
```

Saved preset shape: `-mcs 410 -mct 12 -cs 155136 -chunk_size 2048 -max_length 8192` with
`PYTORCH_ALLOC_CONF=backend:cudaMallocAsync` and no `-ngr`.

Build (3 min): `scripts/build_ext.bat` in the tooling directory. vcvars64,
`CUDA_HOME=D:/personal/models/elx3/.tmp/turbo-match/cuda-13.2.2-build/toolkit` (system CUDA 13.3
lacks cusparse headers), `TORCH_CUDA_ARCH_LIST=8.9`, `DISTUTILS_USE_SDK=1`,
`setup.py build_ext --inplace`. Run detached; it appends `BUILD_EXIT <code>` to `build.log`.
`build/` is an artifact. Do not run `pristine_exle/benchmark-next-flash.ps1`: it fetches and
switches both checkouts and currently benchmarks the 27B model.

Kernel check: `scripts/moe_cpu_ref.py --check` (layer 7, 128 experts, 4 shapes, 12 threads,
bit-exact). Host memcpy ceiling: `scripts/stagebench.py` after building `stagebench.cpp`.

## State and open items

- `pristine_exle/exllamav3`: branch `engine-zero-copy` at `58d19c0` = the rewrite as one commit
  on `origin/dev` c93f3c6. Touches only `cpu/moe_mul1.{cpp,h}`, `cpu/moe_handoff.{cu,h}`,
  `model/moe_cpu_host.py`, `doc/env_vars.md`, `tests/test_moe_cpu_offload.py`. In-place `.pyd`
  is the 58d19c0 build. `eval/__disk_lru_cache__/` is a regenerable perf.py cache.
- The September 5 measurements used a customized engine. Current production uses upstream source; see [the deployment guide](../exl3-backend-setup.md).
- Remaining prefill levers: overlap the router sync with the previous layer's tail (4-10 ms per
  layer exposed at 4096 rows); trim host enqueue (11-14 ms per layer, overlapped today).
- Remaining decode levers: the 0.27 ms per layer GPU critical path (no CUDA graphs in decode; GPU
  sits at P3 / 5001 MHz memory clock, a clock lock needs admin); streaming a share of CPU experts
  over PCIe during decode now that the arena is pinned (ceiling model: roughly +30%).
- Before any upstream submission, Linux checks: `/dev/shm` arena, dropped hugepage promotion,
  `os._exit` child exit, Windows-only memops default.

## Provenance

- Sept 2: ~1,100 prefill / ~28 decode and the probe / tail / n-gram findings, recovered from
  Claude transcripts `c8279a97-…` record 8 and `d08a0cf6-…` records 243-545 on 2026-09-05. Those
  runs omitted `-cs`, so they used perf.py's 32768 default, not the 155k preset.
- Sept 4: 155k-preset study on the old engine (threshold 1, thread counts, RAM embeddings,
  chunk 4096 failure, 256-token generation smoke).
- Sept 5: three sessions (recovery replays, engine rewrite plus sweeps p1-p13 / d0-d7 / n1-n5 /
  m1-m2 / v1, upstream rebase plus u1-u4 / b1-b3 and the logits comparison).
