# llama.cpp vs EXL3 at 30k Context: MTP Depth, QC-Attn, and Where the Flag Actually Lands

## What

Follow-up to [exl3-performance-tuning-2026-07-21.md](exl3-performance-tuning-2026-07-21.md). Three
questions, answered with measurements:

1. Should the llama.cpp 27B preset use MTP draft depth 4 instead of 3 (EXL3 already uses 4)?
2. At a matched 30k-token coding prompt and matched context capacity, how do the two backends
   compare on prefill, decode, and peak VRAM?
3. `EXL3_QC_ATTN=0` was landed on the strength of a "~7 % prefill" measurement at 15.6k. Does it
   hold at 30k, and why is decode unaffected?

Answers: yes to depth 4 on both stacks; llama.cpp wins prefill by ~27 % while EXL3 wins VRAM by
~1.9 GB at equal context; and the QC flag is **prefill-only by routing** — decode never reaches the
code the flag switches, and when forced through it (`EXL3_BC_ATTN=0`) quant-direct decode wins by
~20 % at 32k anyway, so upstream's decode default needs no change.

## Who / When / Where

- Run by Claude at Denys's request, 2026-07-22 morning, plus a manual repro by Denys.
- Machine: RTX 4090 24 GB, Ryzen 9 7900X, Windows 11, torch 2.9.0+cu128, Python 3.10
  (`C:\envs\rl310`), desktop VRAM baseline ~2.1–2.3 GB.
- Stacks: llama.cpp `llama-server.exe` (`C:\Users\denys\Documents\GitHub\llamacpp`) and TabbyAPI
  (port 8098) + exllamav3 1.1.0 (`C:\Users\denys\Documents\GitHub\exllamav3`).
- Models: `Qwen3.6-27B-IQ4_NL_mtp.gguf` and `D:\personal\models\elx3\3.6_27B` (EXL3, 4.02 bpw /
  6.00 bpw head). Same weights class, same tokenizer.

## Model shape (explains most of what follows)

`text_config` of the EXL3 model: 64 layers, `full_attention_interval: 4` →
**16 full-attention + 48 linear-attention layers**, `head_dim 256`, 24 q heads / 4 kv heads,
`mtp_num_hidden_layers` present (MTP head baked in). Only the 16 full-attention layers touch the
KV cache at all, which caps how much any KV-cache or attention-kernel knob can move end-to-end
numbers. The instrumented dispatch counts below confirm exactly 16 attention calls per prefill
chunk.

## Part 1 — Served A/B: MTP depth 3 vs 4, both backends

Harness: fresh server per config, one warmup request, then 2 measured
`/v1/chat/completions` calls. Prompt is SiftKit `src/**/*.ts` concatenated and trimmed against
llama's `/tokenize` to **29,975 tokens**, with a unique `RUN-MARKER` at token 0 so no prefix cache
can hit (verified: `cached_tokens: 0` on every llama run, `Process: 0 cached tokens` on every EXL3
run). `max_tokens` 450, `temperature` 0. Context set to 40000 on *both* stacks so the prompt fits
and the VRAM column is comparable. VRAM sampled at 1 s via `nvidia-smi`, idle taken after load,
peak across the measured requests.

| Config | Prefill T/s | Decode T/s | Accept | VRAM idle Δ | VRAM peak Δ | Wall/turn |
|---|---:|---:|---:|---:|---:|---:|
| llama.cpp MTP **3** (current preset) | 2,186 | 78.2 | 87.1 % | 17,867 MiB | 17,960 MiB | 19.9 s |
| llama.cpp MTP **4** | 2,162 | **81.8** | 77.9 % | 18,040 MiB | 18,269 MiB | 19.7 s |
| EXL3 MTP **4** (current preset) | 1,726 | 78.2 | 84.9 % | **15,720 MiB** | **16,408 MiB** | 23.2 s |
| EXL3 MTP 3 | 1,703 | 74.1 | 86.0 % | 15,506 MiB | 16,164 MiB | 23.7 s |

Δ vs the desktop baseline. Denys reproduced the EXL3 MTP4 row independently: 1,730 / 1,726 T/s
prefill, 80.2 / 78.5 T/s decode, idle Δ 15,605 MiB, peak Δ 16,233 MiB — within noise.

Takeaways:

- **Depth 4 beats depth 3 on both backends.** llama +4.6 % decode (78.2 → 81.8) for −1.1 % prefill
  and ~170–310 MiB; EXL3 +5.5 % decode (74.1 → 78.2). Acceptance falls (87 → 78 % on llama) but
  throughput rises — more accepted tokens per verify round beats a prettier ratio, same conclusion
  as the July 21 doc reached for EXL3.
- **llama.cpp wins prefill by 27 %** (2,186 vs 1,726 T/s). This supersedes the "~2.5–3.5k T/s
  reported" hearsay in the July 21 doc — that figure was never measured on this machine. Measured
  locally at 22k context it was ~2,150 T/s, and at 30k here 2,186 T/s.
- **Decode is a tie at matched depth 4** (81.8 vs 78.2, ~4 % to llama).
- **EXL3 wins VRAM by ~1.9 GB at equal context** (16.4 vs 18.3 GB peak). That headroom is what buys
  the 150k-context production preset; llama.cpp cannot hold it on this card.
- Net: at 30k context llama finishes the same turn ~3.5 s faster. EXL3's justification is context
  capacity, not speed.

## Part 2 — Raw engine numbers (`eval/perf.py`, no TabbyAPI)

Five sequential runs by Denys on an otherwise idle GPU, `-chunk_size 2048` (the production value)
and `-max_length 32768`:

```powershell
cd C:\Users\denys\Documents\GitHub\exllamav3
$env:EXL3_QC_ATTN = '0'   # or '1'
C:\envs\rl310\Scripts\python.exe eval\perf.py -m D:\personal\models\elx3\3.6_27B `
  -cs 32768 -max_length 32768 -chunk_size 2048 [-cq 8,8]
```

Prefill T/s:

| Length | FP16 / off | FP16 / off (repeat) | FP16 / **on** | q8,8 / off | q8,8 / **on** | off-vs-on @ q8,8 |
|---:|---:|---:|---:|---:|---:|---:|
| 2,048 | 2,027 | 2,077 | 2,044 | 2,053 | 2,032 | +1.1 % |
| 4,096 | 2,016 | 1,986 | 2,010 | 2,027 | 1,985 | +2.1 % |
| 8,192 | 1,981 | 1,953 | 1,968 | 1,984 | 1,908 | +4.0 % |
| 16,384 | 1,897 | 1,883 | 1,889 | 1,895 | 1,768 | +7.2 % |
| 32,768 | 1,741 | 1,739 | 1,736 | 1,734 | 1,539 | **+12.7 %** |

Decode T/s: 45.3–45.7 at context 0 and 39.8–41.1 at 32.5k across **all five runs** — no
configuration moved it.

Three conclusions:

1. **TabbyAPI overhead is ≈0.** Engine prefill at 32k is 1,734 T/s; served through TabbyAPI at a
   30k prompt it was 1,726–1,735 T/s. HTTP, sampling, chat templating and the paged generator cost
   nothing measurable. The gap to llama.cpp is exllamav3's kernels, not the server.
2. **`EXL3_QC_ATTN=0`'s benefit scales with context**: +1 % at 2k, +4 % at 8k, +7 % at 16k,
   **+12.7 % at 32k**. The July 21 doc's flat "~7 %" was measured at 15.6k and understates the win
   at production context lengths. The flag is a no-op on an FP16 cache, as expected — 1,736 vs
   1,741/1,739 T/s.
3. **Cache quantization is nearly free.** q8,8 vs FP16 is within 1 % on prefill and, at 32k, decode
   is marginally *faster* quantized (41.0 vs 39.8 — less cache bandwidth). There is no speed upside
   to chasing an FP16-cache configuration; `8,8` costs almost nothing and buys the 150k context.

Cross-check on MTP: raw decode with no drafting is 45.7 T/s at short context and 39.8 at 32k;
served with MTP depth 4 it is 78–80 T/s. **MTP is worth ~1.85×**, consistent with the 43.9 → 80.4
in the July 21 doc.

## Part 3 — Why `EXL3_QC_ATTN` does nothing for decode

The upstream author's expectation was that the flag should change token generation too, and that
seeing identical TG means either the flag is not engaging for TG, or it only switches PP.

**It only switches PP, and not by design of the flag — by routing.** Instrumenting the dispatcher
(wrap every candidate in `_fns_qc` and `attn_fns`, then run `eval/perf.py`) gives, with
`-cq 8,8` and `EXL3_QC_ATTN=1`:

```
===== dispatch: SELECTED =====
prefill(q_len=256)   fn_triton_paged_attn_prefill_qc  cache=qc  calls=16
prefill(q_len=512)   fn_triton_paged_attn_prefill_qc  cache=qc  calls=16
prefill(q_len=1024)  fn_triton_paged_attn_prefill_qc  cache=qc  calls=16
prefill(q_len=2048)  fn_triton_paged_attn_prefill_qc  cache=qc  calls=80
===== dispatch: tried and rejected =====
prefill(q_len=2048)  fn_triton_paged_attn_decode_qc   cache=qc  calls=16
```

The Generation phase ran 9 context lengths × 100 forwards × 16 full-attention layers and dispatched
**zero** attention calls. 16 calls per prefill chunk = the 16 full-attention layers, confirming the
instrumentation sees everything the dispatcher does.

Cause — `exllamav3/modules/attn.py:834-842`:

```python
# Graph-captured C++ path for the whole decode attention block
if (_bc_attn_enable and non_causal_spans is None
        and bsz <= _bc_max_bsz and seqlen <= _bc_max_qlen):
    o = self.bc_attn_step(x, cache, params, block_table, cache_seqlens)
    if o is not None:
        return o          # returns before attn_dispatch is reached
```

`attention_fn/bc_attn.py` captures the entire decode attention block — q/k/v projections, fused
head norm + RoPE, cache append, flash-decoding, o_proj — as one C++ call replayed as a CUDA graph
per `(bsz, q_len)` slot. It reads the quantized cache natively:
`BCAttn(m, layer.qk, layer.qv, layer.sk, layer.sv, layer.k_bits, layer.v_bits)`, with
`quant_cache = self.quant` and `cache_t = "*i32" if self.quant else "*fp16"`. So decode is already
quant-direct through a **separate implementation**, and `EXL3_QC_ATTN` — which only chooses between
`_fns_qc` and `attn_fns` inside `attn_dispatch` — cannot reach it. Gates: `EXL3_BC_ATTN=1` by
default, `MAX_BSZ = 8`, `MAX_QLEN = 16`; bsz1/qlen1 decode and MTP depth ≤ 4 stay well under both,
so BC-attn always wins the race.

Confirmation with BC-attn forced off (`EXL3_BC_ATTN=0`, `-cq 8,8`): decode immediately starts
dispatching, **11,200 calls per run** = 7 lengths × 100 forwards × 16 full-attention layers, and
the flag selects exactly the kernels it is documented to select:

```
EXL3_QC_ATTN=1 -> decode(q_len=1)  fn_triton_paged_attn_decode_qc  cache=qc    calls=11200
EXL3_QC_ATTN=0 -> decode(q_len=1)  fn_triton_paged_attn_decode     cache=fp16  calls=11200
```

So the quant-direct decode kernel is present and correct; only the routing hides it.

An earlier draft of this section reported the magnitude as unresolved, citing a 5.34 T/s
degenerate run and a load-time `GPUassert: an illegal memory access` crash "with the GPU otherwise
idle". Both artifacts came from two agent sessions unknowingly benchmarking the GPU at the same
time (10:02–10:07; see Corrections) — the GPU was *not* idle. The measurement below was taken
after the collision, with a guard that (a) waited for `nvidia-smi --query-compute-apps` to show no
foreign compute process before each run and (b) would have retried any run with a sub-25 T/s point.
All 8 runs passed on the first attempt; no crash and no degenerate run recurred.

Decode T/s (decode-only `-spf`, warmup on, q8,8, `-max_length 32768`; median of 3 alternating A/B
pairs with BC-attn off, plus 2 BC-attn-on reference runs):

| Context | BC off, QC **on** (quant-direct) | BC off, QC **off** (dequant) | on-vs-off | BC-attn on (default) |
|---:|---:|---:|---:|---:|
| 0 | 45.0 | 43.8 | +2.9 % | 46.4 |
| 8,192 | 42.8 | 42.6 | +0.3 % | 44.3 |
| 16,384 | 43.3 | 40.4 | +7.2 % | 43.2 |
| 32,512 | 41.9 | 35.0 | **+19.8 %** | 41.7 |

Spread: the QC-off 32.5k points repeat tightly (34.80 / 35.15 / 34.99); QC-on gave 41.92 / 38.36 /
42.24 (run 2 ran ~5 % low across its whole curve — thermal/desktop noise; the median stands).

Two findings:

1. **Quant-direct is the right decode default, and by more than upstream could measure.** With the
   dispatcher reachable, quant-direct decode beats dequantize-then-attend by ~20 % at 32k — the
   mirror image of the prefill result, exactly as the O(q_len × kv_len) vs O(kv_len) analysis below
   predicts: at q_len = 1 there is nothing to re-unpack, while the dequant path pays an O(kv_len)
   staging cost that grows with context and buys nothing.
2. **BC-attn ≈ quant-direct dispatch at long context.** 41.7 vs 41.9 T/s at 32.5k; the CUDA-graph
   capture is worth ~3 % at short context (46.4 vs 45.0 at context 0 — launch-overhead
   elimination) and nothing once kernel time dominates. BC-attn's decode kernel is itself
   quant-direct, so `EXL3_QC_ATTN` showing zero TG delta in a default build is expected behavior,
   not a malfunction — the flag simply cannot A/B the TG path unless `EXL3_BC_ATTN=0` is also set.

### Why the PP direction is what it is

Quant-direct (`=1`) unpacks K/V tiles from int-packed + scales inside the attention inner loop, so
each K/V tile is re-unpacked for **every query tile** it pairs with: cost scales as
O(q_len × kv_len / BLOCK_M). Dequantize-then-attend (`=0`) calls `CacheLayer_quant.get_kv()`, which
allocates two cache-shaped FP16 tensors and expands the cache **once** (O(kv_len)), after which the
plain FP16 kernel runs at full tensor-core throughput.

Prefill feeds `q_len = chunk_size = 2048` — dozens of query tiles — so the staged dequant amortizes
and wins, more so as context grows. Decode is `q_len = 1`: one query tile, nothing to re-unpack, so
quant-direct is strictly better there and pays for itself by avoiding the FP16 staging buffer
(~240 MiB peak, measured in the July 21 doc). Upstream's default is the right default for
decode-heavy serving on tight VRAM; SiftKit's workload is the opposite — 15–30k prompts,
prefill-dominated, 24 GB card with ~4 GB headroom — so `0` is right here.

## Corrections to earlier claims

- The July 21 doc's "llama.cpp ~2.5–3.5k T/s reported" is not reproducible on this machine.
  Measured: **2,186 T/s** at a 30k prompt, ~2,150 T/s at 22k. Treat 2.1–2.2k as the llama.cpp
  number for this model/GPU.
- The July 21 doc's "`EXL3_QC_ATTN=0`: +7 % prefill" is correct at 15.6k but context-dependent;
  use the curve in Part 2.
- Mid-session, an intermediate claim of "+13.6 % at 32k" was retracted on the basis of a 9.5 %
  run-to-run swing. That retraction was wrong: the swing came from two 27B models sharing the GPU
  (a manual `perf.py` run overlapping an automated batch), which pushed the automated run into
  sysmem fallback — 804 T/s prefill and 3.2 T/s decode in the affected run. Denys's clean
  sequential runs repeat to 0.15 %. **Never benchmark this GPU from two sessions at once**; check
  `nvidia-smi --query-compute-apps` first.
- The same failure mode struck a second time, worse: between 10:02 and 10:07 two *agent sessions*
  each ran their own `EXL3_BC_ATTN=0` decode A/B on the GPU simultaneously. Products of the
  collision: a 5.34 T/s "degenerate" run (sysmem fallback), a load-time
  `GPUassert: an illegal memory access was encountered` crash, and an "unresolved magnitude"
  conclusion briefly published in Part 3 — all retracted; the crash did not reproduce in 8
  subsequent guarded runs on an exclusive GPU. The check must be automated, not remembered: the
  rerun's driver polls `nvidia-smi --query-compute-apps` before every run and rejects any run with
  a sub-25 T/s decode point.

## Reproduce

Served A/B (Part 1): throwaway Node harness, deleted with the session scratchpad. Rebuild sketch —
spawn each server with the args/env below, poll `/health` (llama) or `/v1/model` (Tabby), settle
12 s, sample idle VRAM, send 1 warmup + 2 measured `/v1/chat/completions`, scrape
`prompt eval time` / `eval time` / `draft acceptance` from llama's stderr and
`Process: … at X T/s` / `Generate: Y T/s` / `Draft: a / b` from TabbyAPI's stdout, kill the process
tree, wait for VRAM to return to baseline.

llama.cpp args are exactly `buildManagedLlamaArgs` for `qwen3-6-27b-q4-thinking` with
`-c 40000` and `--spec-draft-n-max {3,4}`; EXL3 env is exactly
`Exl3PresetAdapter.buildLaunchEnvironment` for `exl3-3-6-27b` with `TABBY_MODEL_MAX_SEQ_LEN=40000`,
`TABBY_MODEL_CACHE_SIZE=40192`, `TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS={3,4}`.

Dispatch instrumentation (Part 3) — the whole thing:

```python
import os, sys, runpy, collections
EXL = r"C:\Users\denys\Documents\GitHub\exllamav3"
sys.path.insert(0, EXL)
from exllamav3.modules.attention_fn import dispatch as D

selected, rejected = collections.Counter(), collections.Counter()

def wrap(fn):
    def wrapper(args):
        phase = "decode(q_len=1)" if args.q_len == 1 else f"prefill(q_len={args.q_len})"
        out = fn(args)
        key = (phase, fn.__name__, "qc" if args.q_cache is not None else "fp16")
        (selected if out is not None else rejected)[key] += 1
        return out
    wrapper.__name__ = fn.__name__
    return wrapper

D._fns_qc = [wrap(f) for f in D._fns_qc]
D.attn_fns = [wrap(f) for f in D.attn_fns]

sys.argv = ["perf.py"] + sys.argv[1:]
try:
    runpy.run_path(os.path.join(EXL, "eval", "perf.py"), run_name="__main__")
finally:
    for label, c in (("SELECTED", selected), ("REJECTED", rejected)):
        print(f"\n===== {label} =====")
        for (phase, name, mode), n in sorted(c.items()):
            print(f"{phase:24} {name:36} cache={mode:5} calls={n}")
```

```powershell
EXL3_QC_ATTN=1 python instrument.py -m D:\personal\models\elx3\3.6_27B `
  -cs 8192 -max_length 8192 -chunk_size 2048 -cq 8,8 -swu
# add EXL3_BC_ATTN=0 to force decode through the dispatcher
```

Decode A/B (Part 3 table): `eval/perf.py -m <model> -cs 32768 -max_length 32768 -chunk_size 2048
-cq 8,8 -spf` (decode-only, warmup on), 3 alternating pairs of
`EXL3_BC_ATTN=0 EXL3_QC_ATTN={1,0}` plus 2 runs with BC-attn on; before each run poll
`nvidia-smi --query-compute-apps` until no foreign compute process, and retry any run containing a
decode point below 25 T/s.

## Action items

- [x] Set `SpeculativeDraftMax: 4` on llama presets `qwen3-6-27b-q4-thinking` and
      `qwen3-6-27b-q4-mtp-thinking` (were 3). +4.6 % decode, −1.1 % prefill, ~300 MiB. Applied
      2026-07-22 in `.siftkit/runtime.sqlite` (`app_config.server_llama_presets_json`); flows to
      `--spec-draft-n-max` via `buildManagedLlamaArgs`.
- [x] `UBatchSize: 2048` on `exl3-3-6-27b` — already applied since the July 21 doc.
- [x] `EXL3_QC_ATTN=0` in the managed launch env — already fixed in `Exl3LaunchEnvironmentSchema`.
      Keep it; the win is larger than documented at 30k+.
- [ ] Leave `SpeculativeDraftMax 4`, MTP on, cache `8,8` on EXL3 as-is. FP16 cache is not worth
      testing further — no speed upside, large VRAM cost.
- [ ] Optional, informational: report to exllamav3 upstream that `EXL3_QC_ATTN` is unreachable for
      decode whenever BC-attn builds (so the flag cannot A/B the TG path as intended), with the
      forced-dispatch numbers above: quant-direct decode +19.8 % over dequant at 32.5k, BC-attn
      matching quant-direct at long context. The load-time GPUassert seen mid-session was a
      GPU-sharing artifact, not reproducible on an exclusive GPU — do not report it as a bug.
