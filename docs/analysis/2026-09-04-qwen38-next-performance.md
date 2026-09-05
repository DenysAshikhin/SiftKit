# Qwen3.8 Flash-Next: performance investigation

Date: 2026-09-04. Scope: Flash-Next only; the 27B models were excluded.

**Result:** `EXL3_MOE_STREAM_T=1` raised 8k prefill from 111 to 487–489 tokens/s without changing quantization or cache capacity. Decode remained roughly 19 tokens/s. The previous 2k/50 figures are not established end-to-end ceilings.

**September 5 recovery update:** Earlier measurements of roughly 1,100 prefill and 27–29 decode tokens/s were recovered from Claude transcripts. They used a different benchmark configuration, including a 32k cache and 4096-token chunks. See the [recovery handoff](2026-09-05-qwen38-next-handoff.md) for evidence, commands, and the remaining reproduction gap.

## Machine and exact preset

- RTX 4090 24 GiB, Windows WDDM, NVIDIA driver 610.47, configured power limit 360 W; no hardware settings changed.
- Ryzen 9 7900X, 128 GiB RAM (2 x 64 GiB), reported configured memory speed 5600 MT/s.
- Saved preset `EXL3 3.8_Next` (`exl3-3-8-27b`): `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`, 155000 context / 155136 cache tokens, FP16 KV, 2048-token chunks, 410/512 CPU-resident experts per layer, MTP disabled.
- Model: `Qwen4ExpForConditionalGeneration`; 48 layers, 512 routed experts/layer, 10 selected/token. Checkpoint quantization config: 4.05 bpw, head 6, n-gram table 6. Engine-reported loaded bitrate: 4.29 bpw / 6.01 head.
- Engine: `pristine_exle/exllamav3`, commit `f3f7e42`; Python 3.13.14 from `C:/envs/rl313-turbo`, PyTorch 2.13.0+cu132, installed extension `1.4.6+unified.1`. Explicit `PYTHONPATH` selected the pristine checkout. Its CPU host/kernel source matched the editable install's source.
- Allocator: `PYTORCH_ALLOC_CONF=backend:cudaMallocAsync`, matching Tabby's default.

## Method

Use the checkout's existing `eval/perf.py`, warmup enabled, `max_length=8192`, unchanged weights/cache/split. This reads the cached WikiText-2 workload and tests prefill through 8192 tokens and single-token decode through context 7936. It is a raw engine throughput benchmark, not an application latency benchmark or quality evaluation.

An initial attempt overlapped another session's 27B GPU test and was killed. The first completed run had overlap during early loading only; exclude it as the definitive reference. A later fully isolated reference reproduced slow prefill and is the comparison baseline.

The diagnostic profile used `max_length=2048`; `perf.py` changes token offsets with this argument, so its throughput is not compared directly to the 8192 runs. It was used only to inspect internal phases.

All comparisons preserve the full cache allocation. Processing 8k does not validate serving a 155k prompt. The text-only harness does not load the vision tower; the saved preset offloads that tower to host RAM.

## Why prefill is slow

The automatic expert-streaming heuristic probes one 16 MiB pinned-host-to-device copy after two warmup copies. The diagnostic run measured 6.8 GB/s and chose `stream_t=58`. Experts with fewer than 58 token assignments in a chunk stayed on CPU. At a 2048-token warmup chunk, early layers streamed only about 102-110 of their 410 CPU experts, leaving substantial work on the CPU.

The CPU worker was already using AVX-512/VBMI and 12 threads. Its prefill profile was dominated by the two matrix phases, not an absent optimized instruction-set path. Lowering the threshold moves more prefill work to the GPU using the existing streaming machinery; it does not change model weights or KV precision.

Source: `pristine_exle/exllamav3/exllamav3/model/moe_cpu_host.py:888` (bandwidth probe and threshold), `:972` (streaming selection), and `pristine_exle/exllamav3/doc/env_vars.md:239` (override).

The measured 6.8 GB/s is this initialization probe's result, not proof of the PCIe link's sustainable maximum. GPU link state was PCIe 4.0 x16. A better upstream heuristic would measure CPU-versus-GPU execution cost for this model as well as transfer bandwidth, rather than scaling a fixed threshold only by transfer bandwidth.

## What the old 2k / 50 estimates mean

Neither 2000 prefill tokens/s nor 50 decode tokens/s was established as this preset's end-to-end theoretical maximum.

Reading the checkpoint tensor headers gives 60,870,131,712 bytes of main-model routed expert tensors. Uniform routing across the saved split implies approximately `60.87 GB * 10/512 * 410/512 = 0.952 GB` of CPU expert weights/token. Actual routing is nonuniform; the decode profiler observed about eight CPU expert assignments/token/layer.

The processor has two memory channels ([AMD specifications](https://www.amd.com/en/products/processors/desktops/ryzen/7000-series/amd-ryzen-9-7900x.html)). At the machine's reported 5600 MT/s, theoretical DRAM payload bandwidth is `5600e6 * 8 * 2 = 89.6 GB/s`. Dividing by the illustrative 0.952 GB/token gives about 94 tokens/s for *weight reads alone*, ignoring computation, cache/activation traffic, GPU work and synchronization. This is a conditional subsystem estimate, not achievable decode speed. It does not justify either a 50 tokens/s cap or a promise of reaching 50.

Late decode profile samples typically took about 0.5-0.7 ms of worker computation plus 0.3-0.4 ms waiting for input readiness per layer, with occasional much longer outliers. Across 48 sequential layers this is consistent with roughly 20 tokens/s; it identifies substantial CPU and handoff cost.

Likewise, an idealized all-streaming prefill would move roughly 48.7 GB of CPU-resident expert weights/chunk. At an assumed sustained 25 GB/s, that alone takes 1.95 s: about 1050 tokens/s with 2048-token chunks or 2100 with 4096, before other work. The current hybrid path streams only selected experts and computes the rest on CPU, so these illustrative numbers are not bounds on the actual mixed execution path. The 4096-chunk load failed at the saved cache/split. Larger claimed maxima require explicit assumptions and measurement.

## Measured results

Tokens/second; all rows below use the same 8192-length workload and 2048 chunk unless stated otherwise.

| Configuration | Prefill 8192 | Decode context 1024 | Decode context 7936 | Result |
|---|---:|---:|---:|---|
| Saved settings, isolated reference | 111.22 | 19.18 | 20.78 | Passed |
| Six CPU threads | 92.41 | 20.40 | 20.00 | No consistent benefit |
| Stream threshold 16 | 423.12 | — | — | Prefill-only trial passed |
| Stream threshold 1 | 486.75 | 19.68 | 19.58 | Passed |
| Stream threshold 1, repeat | 489.21 | 18.46 | 18.70 | Passed |
| Threshold 1 + RAM embeddings | 495.82 | 21.85 | 18.44 | Small, inconsistent decode change; +36 GiB RAM |
| Threshold 16 + chunk 4096 | — | — | — | Load failed: insufficient VRAM |

**Confirmed gain: 4.38–4.40x prefill** with threshold 1 against the isolated reference. An 8192-token prefill falls from about 73.7 seconds to 16.7–16.8 seconds in this benchmark. This is a prefill gain; decode did not improve consistently. Threshold 1 was the fastest disk-streaming setting tested, not the result of an exhaustive search over every tuning parameter.

The repeated threshold-1 run sampled GPU memory every two seconds: peak 23,572 MiB used of 24,564 MiB. This leaves about 992 MiB at the sampled peak and is not proof of margin for a full-length prompt. The RAM-embedding trial left about 18.8 GiB of physical host memory free after loading.

Normal generation smoke: `examples/chat.py`, ChatML, thinking enabled, preset sampling values, 256-token output cap. It emitted coherent reasoning and explanatory prose about a TypeScript LRU cache, reported 255 generated tokens at 18.91 tokens/s, hit the intentional cap, and exited 0. Its short 55-token prompt was cold; its prompt-processing rate is not compared to the warmed benchmark. No full response-quality, PPL/KLD, native-template, or Tabby/SiftKit API validation was performed.

## Reproduction and practical setting

Set this in the environment of the process that starts Tabby (or starts SiftKit, which launches Tabby):

```powershell
$env:EXL3_MOE_STREAM_T = '1'
```

Retain the existing 2048 chunk, 410 CPU experts, FP16 cache, and model quant. The override is read when the engine imports/loads, so the inference process must restart. It affects eligible prefill chunks; single-token decode stays on its CPU/GPU split path. It is a model/hardware-specific tuning result, not a universal default for every model.

Reproduce the winning raw benchmark from the SiftKit workspace:

```powershell
$env:PYTHONPATH = 'C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTORCH_ALLOC_CONF = 'backend:cudaMallocAsync'
$env:EXL3_MOE_STREAM_T = '1'
& 'C:/envs/rl313-turbo/Scripts/python.exe' `
  'pristine_exle/exllamav3/eval/perf.py' `
  -m 'D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6' `
  -mcs 410 -cs 155136 -max_length 8192 -chunk_size 2048
```

Remove `EXL3_MOE_STREAM_T` in a fresh shell/process for the automatic reference. For the other trials, use value 16, add `-mct 6`, add `-ngr`, or change chunk size to 4096 as the table describes. `-sg` was used for prefill-only trials. The diagnostic profile enabled `EXL3_MOE_CPU_PROF`, `EXL3_MOE_HANDOFF_PROF`, `EXL3_MOE_STREAM_DEBUG`, and `EXL3_NGRAM_GATHER_PROF`, and used `-max_length 2048`.

Further decode work would need a separate controlled investigation of CPU kernels, synchronization, resident-expert placement, or speculative decoding. MTP was not tested here, and 50 decoded tokens/s remains unproven. Keeping the same weights does not guarantee bit-identical CPU/GPU arithmetic; quantitative numerical equivalence was not evaluated.

No saved preset, model weights, hardware settings, or implementation source was changed. Temporary dependency copies were used to satisfy the example chat runner's optional console imports and were removed afterward. All benchmark/console processes exited; the GPU was freed. The unrelated `docs/analysis/qwen38-next-vram-evidence-2026-09-04` work was preserved.


## Validation and retained evidence

- Repeated winning benchmark: exit 0, 486.75 and 489.21 tokens/s at 8192 prefill tokens.
- Fresh isolated reference: exit 0. The 4096-chunk experiment failed at load and is not recommended for this cache/split.
- Real generation smoke: exit 0 after installing the example's declared console dependencies temporarily. The 256-token cap was intentional.
- `npm run typecheck`: passed after scratch cleanup, including all configured TypeScript projects and its `npm run lint` stage. The initial lint attempt hit a permission error scanning temporary Python dependency files; deleting those files resolved it.
- Full application tests were not run: this investigation changed documentation/data only. Benchmarks and the generator smoke cover the inference behavior tested here; they do not validate native API integration, a full 155k prompt, MTP, or quantitative output quality.
- [Measured point data](2026-09-04-qwen38-next-performance.json) includes original run identifiers, statuses, and all recorded prefill/decode points. `baseline-clean` is preliminary despite its original log name; `reference-repeat` is the definitive isolated reference. Transient raw logs/scripts/dependencies were removed.
