# EXL3 Prefill/Decode Performance Investigation & Tuning

## What

Benchmarked SiftKit's EXL3 backend (TabbyAPI + exllamav3 1.1.0) to explain why prompt
prefill (~1.0–1.4k T/s) trails llama.cpp (~2.5–3.5k T/s reported) on the same 27B model
class, and measured the effect of the tunable knobs: `chunk_size` (preset `UBatchSize`),
MTP speculative draft depth (`SpeculativeDraftMax`), and the `EXL3_QC_ATTN` env toggle.

## Who / When / Where

- Run by Claude (Claude Code session) at Denys's request, 2026-07-21 evening.
- Machine: RTX 4090 24 GB, Windows 11, torch 2.9.0+cu128, Python 3.10 (`C:\envs\rl310`).
- Server: TabbyAPI at `C:\Users\denys\Documents\GitHub\TabbyAPI` (port 8098, auth off),
  exllamav3 1.1.0, launched with the exact env `Exl3PresetAdapter.buildLaunchEnvironment`
  emits for preset `exl3-3-6-27b` (Qwen3.6-27B EXL3 4bpw, hybrid linear/full attention,
  `max_seq_len` 150000, cache 150016 @ `8,8`, MTP draft cache Q8, `max_batch_size` 1).
- Harness: throwaway Node driver in the session scratchpad (deleted after this doc).
  Fresh server process per config; per-config warmup request to absorb Triton autotune;
  2 measured requests via `/v1/chat/completions` (production-like), 15,635-token prompt
  built from SiftKit source, `temperature` 0, `max_tokens` 450 (kept below the ~512-token
  requeue boundary so TabbyAPI's finish line reports clean uncached prefill stats).
  Prefill/decode T/s read from exllamav3's own per-request stats line; VRAM via
  `nvidia-smi` (idle-after-load and 1 s-interval peak during requests), delta vs the
  ~2.0 GB desktop baseline.

## Why (root-cause analysis)

1. **`chunk_size` 512 vs default 2048.** `Exl3PresetAdapter.buildLoadRequest` maps
   `chunk_size: preset.UBatchSize`; the preset had 512 (copied from llama.cpp's ubatch).
   exllamav3's prefill is a compute-bound GEMM per chunk, tuned for 2048 — 512
   underutilizes the 4090.
2. **EXL3 quantization is compute-heavy to decode.** Trellis-coded (QTIP-style) weights
   must be procedurally reconstructed, unlike GGUF's cheap `scale × int` unpack. Prefill
   is compute-bound, so this is a structural tax llama.cpp doesn't pay; it's the price of
   EXL3's better KLD-per-bit and smaller footprint. This — not configuration — is most of
   the remaining gap after tuning.
3. **Quantized-cache attention path.** With cache `8,8`, prefill attention runs
   quant-direct Triton kernels (`EXL3_QC_ATTN=1` default). On this 4090 the
   dequantize-then-attend path (`EXL3_QC_ATTN=0`) is ~7 % faster at prefill, decode-neutral.
4. **MTP drafting taxes prefill slightly.** With MTP on, every prompt chunk runs the full
   forward (hidden-state export for the draft cache) instead of the cheaper prefill path:
   ~3 % prefill cost. It roughly **doubles** decode (80 vs 44 T/s), so it stays on.
5. **Decode gap vs llama.cpp is smaller by nature.** Decode is bandwidth-bound and 4 bpw
   EXL3 weights are smaller than IQ4_NL; residual overhead is Python/Torch per-token cost,
   quantized-cache dequant that grows with context, and MTP acceptance variance (49–88 %
   observed in production logs).

Verified not the problem: flash-attn is absent from the venv, but exllamav3 1.1.0 prefers
its own Triton paged kernels (`has_triton=True`) and upstream measured them faster than
FA2 on Ada — the fast path was already active.

## Results

Prompt 15,635 tokens uncached, decode 450 tokens, avg of 2 runs. VRAM deltas vs desktop
baseline (~±150 MiB noise from other apps).

| Config (chunk / MTP draft / QC attn)        | Prefill T/s | Decode T/s | Acceptance | VRAM idle Δ | VRAM peak Δ |
|---------------------------------------------|------------:|-----------:|-----------:|------------:|------------:|
| **512 / 4 / on** (preset before)            |        1408 |       80.4 |     66.8 % |  19,576 MiB |  20,082 MiB |
| 1024 / 4 / on                               |        1665 |       80.5 |     67.1 % |  19,768 MiB |  20,338 MiB |
| 2048 / 4 / on                               |        1749 |       78.4 |     65.4 % |  19,540 MiB |  20,206 MiB |
| 4096 / 4 / on                               |        1753 |       80.5 |     66.8 % |  19,510 MiB |  20,659 MiB |
| 2048 / 3 / on                               |        1751 |       76.0 |     73.8 % |  19,416 MiB |  20,050 MiB |
| 2048 / 2 / on                               |        1745 |       68.0 |     85.0 % |  19,255 MiB |  19,921 MiB |
| **2048 / 4 / off** (recommended)            |        1877 |       80.4 |     67.5 % |  19,428 MiB |  20,446 MiB |
| 2048 / MTP disabled / off                   |        1930 |       43.9 |          — |  18,337 MiB |  19,241 MiB |

Takeaways:

- **`UBatchSize` 512 → 2048: +24 % prefill, free.** Idle VRAM is flat (within noise);
  peak grows only ~120–360 MiB. Gains plateau hard after 2048 (4096 adds nothing but
  ~450 MiB peak). 1024 captures ~75 % of the win if peak VRAM ever matters.
- **`EXL3_QC_ATTN=0`: further +7 % prefill (1749 → 1877), decode neutral,** ~240 MiB
  extra peak. Combined with chunk 2048: **1408 → 1877 T/s (+33 %) for ~0.4 GB peak VRAM.**
- **Keep `SpeculativeDraftMax` 4.** Shallower drafts raise acceptance % but lower
  throughput (d4 80.4 > d3 76.0 > d2 68.0 T/s): more accepted tokens per verify round
  beats a prettier acceptance ratio. MTP itself is strongly net-positive — decode 80 vs
  44 T/s for ~1.1 GB VRAM and ~3 % prefill.
- **Ceiling:** ~1.9k T/s prefill is the practical limit for this model/GPU/format today;
  the rest of the gap to llama.cpp is EXL3's dequant compute, not configuration.

## Benchmark trap found on the way (not a production bug)

Early runs measured decode at 12–23 T/s with `Draft: 0/0`, non-monotonic in prompt
length. Cause: the first harness used raw `/v1/completions` with `ban_eos_token: true`;
for prompts whose greedy continuation wanted to stop early, the model was forced past
EOS and emitted only special tokens (empty visible text). That degenerate stream
disables MTP drafting and crawls. Same lengths with different content drafted fine —
content-dependent, not length-dependent. SiftKit's real traffic (chat endpoint, no EOS
ban) is unaffected; production logs show drafting active at up to 28k context.

## Action items

- [ ] Set `UBatchSize: 2048` on preset `exl3-3-6-27b` (maps to TabbyAPI `chunk_size`).
- [x] Set `EXL3_QC_ATTN=0` in the managed TabbyAPI launch environment — done:
      `Exl3LaunchEnvironmentSchema` now carries it as a fixed `'0'` and
      `Exl3PresetAdapter.buildLaunchEnvironment` always emits it, so every managed EXL3
      launch (and the process signature that triggers restarts) includes it.
- [ ] Leave `SpeculativeDraftMax: 4`, MTP on, cache `8,8` as-is.
