# Performance approaches: consolidated results

Consolidated from the September 2–7 engine, zero-copy, staging, prefetch, grouped-prefill,
and feed-prototype records. This is a historical comparison; no new benchmarks were run.

Unless stated otherwise, rates are **32k prefill tokens/s, Windows, RTX 4090 / Ryzen 9
7900X, chunk 4096, 410 CPU experts, 12 CPU threads**, on the same model family/checkpoint.
Engine revisions, staging geometry and machine state differ between experiment groups.
Compare each candidate with its own listed control. Percentage gains are not additive.
Single-run differences of a few percent are not proof of improvement; several sessions
showed 10–15% variation, and the latest controls varied even more.

**Baseline correction after checking upstream source:** `c6c45b1` already defaults
`EXL3_MOE_MEMOPS` to 1 and already contains a warmed, best-of-eight bandwidth probe.
The historical 1,019 run explicitly set memops to 0; it must not be described as an
unmodified-default upstream benchmark. The 1,121 memops-on control also used 64 MiB rather
than default 32 MiB weight slots. The historical on/off gains below are configuration
comparisons, not new code gains over upstream defaults. The retained probe change adds a
full-duration warmup and repeat/convergence checks; the older 901→414 bad-probe example
does not isolate the benefit of that new retry logic. Preserving large GPU batches is part
of decoupling the piece ring, not another independently measured optimization.

## Improved-staging changes ranked by code invasiveness

Comparison reference is the tested upstream `c6c45b1`, not a fresh remote-HEAD benchmark.
PP means 32k prefill at chunk 4096. Unknown effects are not measured zeroes. This is a code
scope/risk ordering, not an implementation sequence: the spin fix requires the new pool,
and automatic piece sizing requires the new piece ring.

| Order | Change | Code invasiveness | PP evidence relative to upstream | Decode evidence relative to upstream |
|---:|---|---|---|---|
| 1 | Enable CUDA stream memops | None: already upstream's default; existing configuration knob | No new gain over the upstream default. Historical +16.5% compared on/off within a piece-ring configuration. | No new change versus upstream default. Turning it on versus an explicit off override did hurt decode in earlier tests. |
| 2 | Preserve large GPU compute batches | No independent change: retain the existing compute batching while changing CPU staging granularity | No separable speedup. This is a requirement of the piece-ring design below. | No separate change. |
| 3 | Add probe retries and guarantee full warmup duration | Low: host Python plus small validation helper | Avoids incorrect automatic thresholds; not isolated against the already-warmed upstream probe. Fixed-T8 speed runs cannot measure this benefit. | No intended decode hot-path change; isolated decode A/B not run. |
| 4 | Correct the new pool's spin/sleep budget | Small native edit, dependent on the new pool | Removed a prototype regression (543→1,136 with stock-size jobs); approximately restored memops-on upstream throughput, rather than demonstrating a new gain over it. | Unmeasured; persistent helpers may affect CPU contention around phase transitions. |
| 5 | Detect L3 and derive piece geometry | Low–moderate: Windows/Linux topology parsing, sizing helper and host allocation wiring | No isolated A/B; automates manually selected piece geometry that worked. | No intended decode hot-path change; isolated decode A/B not run. |
| 6 | Persistent staging workers | Moderate: native thread lifecycle and job synchronization; rebuild required | Standalone gain over upstream not established. With the ring, corrected configurations reached ~1,366–1,455, but their independent pool contribution is not isolated. | Unmeasured; worker lifetime/spinning requires regression testing. |
| 7 | Small pinned piece ring, decoupled from GPU batch size | Highest within staging: host allocation/enqueue plus native stage-job and per-piece ready/free protocol; rebuild required | Ring + inline staging measured 1,121→1,320–1,458 (+18–30%) versus a memops-on upstream control using 64 MiB slots. This is a combined configuration result, not a one-change default-settings ablation. | No intended change to decode math or arena placement; no isolated end-to-end decode result establishes a percentage. |

The useful measured PP improvement belongs to the ring/stager combination. Existing memops,
probe warmup, preserved batching, automatic sizing and the pool's regression fix must not be
counted again as independent additive improvements over upstream.

Source keys: [E: early engine record](2026-09-05-qwen38-flash-next-engine.md),
[C: controlled follow-up](2026-09-05-performance-controlled-followup.md),
[Z: zero-copy validation](2026-09-06-pr341-hardening-gpu-validation.md),
[V: zero-copy review validation](2026-09-06-zero-copy-pr-validation.md),
[S: staging/cache investigation](2026-09-06-zero-copy-middle-ground-direction.md),
[O: online experiments](2026-09-07-online-prefetch-worklog.md),
[G: grouped acceptance](2026-09-07-grouped-prefill-results.md),
[F: prefill/feed investigation](2026-09-07-prefill-feed-investigation.md),
[P: latest run metrics](2026-09-07-prefill-feed-prototypes.json).

## Main implementation approaches

| Approach | Control → result | Measured impact / interpretation | Current disposition | Source |
|---|---|---|---|---|
| Whole-arena zero-copy DMA (PR 341) | Windows stock 824–1,020 → patched median 1,754; WSL stock 895–1,045 → patched median 1,927 | Large prefill gain, roughly 1.7–2.2× these historical stock references. Patched medians are five-run results; stock and candidate were not one interleaved series. | Effective, but replacing/pinning the arena is excluded by current constraints. Upstream reported THP/decode and load-time regressions on another Linux machine. | C, Z, S §1 |
| Smaller pinned staging pieces while keeping large GPU expert batches | With memops: stock staging 1,121 → piece ring + inline stager 1,320–1,458 | **+18–30%** over that staging control. Avoids spilling the entire pinned ring out of L3. | Principal useful staging mechanism; arena stays untouched. | S §6c–e |
| First piece-ring version, still spawning threads per piece | Stock 1,019 → 715–1,062 across geometries | Mostly slower; small pieces multiplied spawn/join overhead. | Superseded by inline staging / persistent workers. | S §6b |
| Inline single-thread staging for small pieces | Same 3×2 piece geometry: 919 → 1,251 with memops off | **+36%** versus that thread-spawning version; about +23% versus 1,019 stock. | Demonstrated that per-piece thread creation was costly. Larger pieces still needed more copy throughput. | S §6b–c |
| Persistent stager pool with sufficient spinning before sleep | Corrected 4×2 runs 1,366–1,386; 5×2 1,455. Earlier 4×2 run 1,514. | Supports larger pieces without thread creation; no clearly isolated large gain over the best inline ring. Premature sleeping caused severe failures: stock-batch 543 → 1,136 after fixing the spin budget. | Useful supporting component, not a separate additive throughput multiplier. | S §6f–g |
| L3-derived automatic piece geometry | Detected 32 MiB L3 domain → 18.75 MiB pinned ring in later experiments | No isolated before/after throughput result. Automates the successful small-ring geometry. | Portability mechanism supporting the ring. | O, G, F §1 |
| Warmed and retried bandwidth probe | Bad readings 3.4–6.8 GB/s → correct ~26–27 GB/s. Historical bad selection reduced prefill 901 → 414. | Prevents accidentally selecting a much larger CPU tail. Not an independently measured steady-state speedup when threshold is fixed at T8. | Useful reliability fix. | E, S §9g, F §1 |
| Large pinned FIFO instead of an L3-sized ring | Small-ring reference 1,340–1,455; 470 MB FIFO 986; 1.25 GB FIFO 1,111 | Slower despite more buffering. 2.5 GB configuration failed allocation. | Rejected: larger buffers did not fix the DRAM traffic cost. | S §9b |
| Fill-once pinned expert cache | Median 1,368 → median 1,407 with 2 GB cache | **+2.9% observed**, only 8% byte hits; candidate runs included a 1,132 probe outlier. 5/10 GB allocations failed. | Small return and added memory/state; rejected from the intended design. | S §9c |
| Resident pinned expert subset, no duplicate weights | Control median 1,368; 10 GB: 1,476; 20 GB: 1,512; 40 GB median: 1,748 | Approximately **+8%, +11%, +28%** against that historical control. Only 40 GB had three candidate repeats. At high residency it approaches whole-arena zero-copy. | Effective at large pin budgets, but changes arena placement and inherits the rejected pinning tradeoff. | S §9e–g |
| Previous-chunk prefetch during attention | Initial same-load controls 1,247–1,269; attention-only 1,257 | Initially flat despite substantial prediction hits. A 512 MiB trial gave 1,269 vs separate control 1,211, but later comparisons did not establish that gain. | Later consumption variants below supersede the initial apparent improvement. | O §§Latest progress/subsequent results |
| Earlier next-layer prefetch, started during the current MLP | Controls 1,247–1,269 → 1,152–1,177 | Roughly **6–9% slower**. Timeline confirmed overlap actually occurred. | Rejected. Overlap alone did not improve total throughput. | O |
| Prefetch hits copied to GPU slots on the compute stream | 1,502 → 1,330 | **−11.5%**. | Rejected. Added work to the compute stream. | F §4 |
| Prefetch hits copied on the copy stream | 1,502 → 1,429 | **−4.9%**. With CPU tail disabled: 1,386 → 1,236 (−10.8%). | Rejected. Hit copies queued behind the layer prefetch. | F §4 |
| Prefetch hits computed directly in the prefetched VRAM buffer | 1,513 → 1,448–1,481 | **−4.3% to −2.1%**. Weight-wait time fell, but the whole MLP did not become faster. | Rejected. Closest prefetch variant to neutral. | F §4 |
| CPU tail on a separate CUDA stream | Same-load serialized controls 1,266–1,281 → async T8 1,179 | **~7–8% slower**. Async plus early prefetch: 1,154. | Rejected; correctness passed, performance did not. | O §Current checkpoint |
| Tail job window sized to cover the chunk | 1,500 → 1,569–1,586 with 8 slots and 256/512 rows | **+4.6–5.8% observed** over three candidate runs; 8×512 avoids inline collection for a 4096-row chunk. | Useful measured direction. A generic chunk-derived policy remains to be specified. | F §5 |
| Layer-major grouped MLP prefill | Two-chunk median 1,183 → 1,712; final automatic grouping median 1,208 → 1,970 | **+44.7%** for two chunks; **+63.1%** final, each from five interleaved pairs. Standalone automatic run: 1,931. | Strongest controlled staging-based gain, but user rejected its model-order/API/consumer changes. | O, G |
| Grouped memory-lifetime cleanup and automatic admission | Early four-chunk variant ~1,210 vs ~1,219 control; memory-corrected fixed-four 1,931 vs 1,171; final automatic result above | Prevented oversubscription / excessive activation residency from erasing grouping's gain. Not a separate additive speedup. | Part of the rejected grouped architecture. | O, G |

## Latest two prototypes, with matched controls

All rows below passed full-output comparisons against the original streamed scheduler on
the exact same input/routing tensors across 47 exercised offload layers. These are single
screening pairs, not three-pair confirmation series. A+B was generated but not benchmarked.

| Approach | Weight slots / CPU tail window | Control → result | Change | Interpretation |
|---|---|---:|---:|---|
| A: two-phase prefill issue/collect | Default 2×32 MiB / default tail | 965.32 → 863.46 | **−10.6%** | Regression in this pair. |
| A | 4×64 MiB / default tail | 1,177.66 → 1,039.18 | **−11.8%** | Less weight waiting, slower overall. |
| A | Default weight slots / 8×512 tail | 1,347.46 → 1,351.98 | **+0.3%** | Effectively tied. |
| A | 4×64 MiB / 8×512 tail | 1,401.92 → 1,407.08 | **+0.4%** | Weight waiting fell 14.53 → 6.49 s, without useful throughput gain. |
| B: alternate pieces between two copy streams | Default weight slots / default tail | 1,229.22 → 1,239.32 | **+0.8%** | Within variation. Piece copy+gate time improved 0.615 → 0.595 ms (~3.2%); DMA ~19.7 → 19.6 GB/s. |

Neither A nor B earned promotion from screening. The measurements do not prove that every
possible small gain is zero; they do not support the proposed large gains. Sources: F §8, P.

## Parameter sweeps, earlier levers, and microbenchmarks

These include historical configurations outside today's fixed-chunk/arena constraints.
They are included for completeness, not as new implementation proposals.

| Approach | Measured effect | Interpretation / limit | Source |
|---|---|---|---|
| Shrink the original coupled CPU/GPU slots | 32 MB: 1,019; 16 MB: 1,099 (**+7.9%**); 8 MB: 847; 4 MB: 607 | Smaller slots also shrank compute batches; too small became much worse. This motivated decoupled pieces. | S §6a |
| Enable CUDA stream memops for staging | Stock reference 1,019 → 1,121 (**~+10%**, geometry also differed); same inline piece configuration 1,251 → 1,458 (**+16.5%**) | Helpful to the staging handshake; not the same finding as decode's memops preference. | S §6c–d |
| Disable memops for decode | Early Windows ~25–28 → 30–32 tok/s; controlled WSL examples ~20–22 → ~25–26 | Decode-specific benefit. A global setting can trade staging speed against decode speed. | E, C |
| Increase ring depth or use larger pieces | 3×2 inline/memops 1,320–1,458; 3×3 1,215; 6×2 1,141; 4×3 1,072 | More depth/size did not help; extra handshakes and L3 spill mattered. | S §6d |
| More VRAM slots without a new mechanism | Ring runs at 3/4 slots: 1,306/1,341; zero-copy 2 vs 4 slots: 1,815/1,841 | No demonstrated gain. Recent wide-slot controls are not mechanism wins by themselves. | S §9d, E |
| Stager/compute thread tuning and CCD isolation | Ring throughput mostly 1,329–1,368; some larger isolated-ring variants 1,208–1,321 | No useful improvement beyond the existing plateau, even where copy bandwidth rose. | S §9d |
| Disable CPU tail by streaming everything (T1) | 1,502 → 1,386 (**−7.7%**) | CPU staging copy sped up, but PCIe bytes rose ~46%; total throughput fell. | F §3–4 |
| Raise streaming threshold to move more work to CPU | Serialized T8 controls 1,240–1,286; T32 652. Async T8/T16/T32: 1,179/964/662 | Large regression. The earlier T1 workaround for a broken probe was superseded once the probe was fixed. | O, E |
| Disable swizzle | Latest prefill 1,502 → 1,513 (**+0.7%**, neutral). Earlier decode fell from ~28.5–29.5 to ~26.9–27.4 | No meaningful prefill win; historical decode cost argues against treating it as free globally. | F §4, E |
| Increase ordinary chunk size to 8192 | Retained staging tree: 4096 median 1,359 → 8192 median 2,234 (**+64% observed**, separate sweeps). Earlier zero-copy: ~1,749 → 2,044–2,591 | Large reuse benefit without a new scheduler, but outside the fixed-4096 requirement. Not a new mechanism. | F §2, C |
| Larger chunks beyond 8192 | 12288: 1,963, with mixed chunk lengths; 16384: OOM | 12288 is not an apples-to-apples result; 16384 did not fit. | F §2 |
| Change CPU offload count | Zero-copy 410 → 394 experts: 1,749 → 1,782 (**+1.9%**); no robust decode improvement | Small/unproven; standalone offload-count tuning is excluded now. | C |
| Production 155k-cache capacity workaround | Staging chunk 2048/410: 846; chunk 8192/430: 2,120; /450: 2,087. Chunk 4096 or 8192 with 410 failed loading | Multiple settings changed; not an isolated chunk or offload effect. | F §2 |
| Band-unit GEMV partition | Bit-exact kernel checks; early combined build suggested ~5% better decode | No isolated end-to-end measurement established that percentage independently of other changes/machine state. | E, C |
| More decode workers / SMT | Controlled 6 or 12 workers: ~24–26 tok/s; 24 workers: ~4.2–4.4 | Severe oversubscription regression; more workers did not mean more throughput. | C |
| Cap the fused GPU kernel | Historical cap 0/32/128: 409/681/898 vs 905 uncapped | Restricting fusion hurt, especially disabling it. | E |
| Put embeddings in RAM (`-ngr`) | Historical ~4–5% prefill gain, at ~36 GiB host-RAM cost | Capacity tradeoff, not a free optimization. Earlier preset retained SSD-backed embeddings. | E |
| L3-sized ring, isolated copy/DMA benchmark | 2×32 MB: 19.6 GB/s; 2×8 MB: 26.6 GB/s (**+36%**) | Mechanism evidence, not end-to-end tokens/s. Real-engine gains needed batching/thread fixes. | S §3 |
| Non-temporal stores for staging | Copy alone improved ~18.5 → 30.4 GB/s, but pipeline delivered only 18–21.5 vs cached small-ring memcpy ~26.6 | Faster isolated memcpy did not make the pipeline faster; bypassed the useful cache residency. | S §2–3 |
| Offline LRU/static/optimal expert caching | At 5 GB and chunk 4096: 0% / 19% / 22% byte hits; at 10 GB LRU still ~3% | Trace simulation only, not a measured runtime speedup. Cyclic layer traversal defeated small LRU caches. | S §9a |
| Native vs cudaMallocAsync allocator | No isolated comparison | No attributable performance conclusion. | E |
| Compiler `-Ofast` vs `-O3` | `-O3` fixed synthetic overflow/NaN behavior and matched Windows outputs | Correctness diagnostic; no isolated throughput gain measured. | V |
| Arena lifecycle, capacity checks, cleanup and profiler repairs | No demonstrated hot-path speedup; most checks are startup/shutdown or diagnostic | Reliability/correctness work, not performance mechanisms. Later hardening throughput remained inside earlier ranges. | Z |

Unimplemented ideas should not be counted as measured results: memfd backing, restoration
of shmem hugepages, asynchronous embedding gather, per-model hotness placement, and the
combined A+B variant. Linux full-model grouped/ring acceptance was blocked by host commit
capacity; the successful Windows results do not establish Linux performance for those paths.

The useful arena-preserving result is the small piece ring with appropriate worker/handshake
handling. The tail window offers a smaller observed improvement. Zero-copy and grouped
prefill showed larger gains but violate decisions already made about arena and execution
scope. Cache/prefetch/extra-stream work did not produce a convincing additional gain under
the current constraints.
