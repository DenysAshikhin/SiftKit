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
- [x] ~~Set `EXL3_QC_ATTN=0` in the managed TabbyAPI launch environment~~ — shipped as a fixed
      `'0'` in `Exl3LaunchEnvironmentSchema` from 2026-07-21, then **reverted on 2026-09-02** so
      SiftKit injects no engine environment that is not derived from a preset field. Operators
      who want the dequantize-then-attend path export `EXL3_QC_ATTN=0` in the shell that starts
      SiftKit; the managed child inherits the parent environment.
- [ ] Leave `SpeculativeDraftMax: 4`, MTP on, cache `8,8` as-is.

## `PenaltyRange` / `OMP_NUM_THREADS` / `KMP_BLOCKTIME` — added 2026-07-30, removed 2026-07-30

All three were workarounds for two exllamav3 defects, both fixed upstream by
[`8e08af9`](https://github.com/turboderp-org/exllamav3/commit/8e08af9) the same day they
shipped. The engine venv (`C:\envs\rl313`) now runs a source build of exllamav3 `dev` @
`8e08af9`, so SiftKit sends none of them:

- **`PenaltyRange`** was a preset field defaulting to `4096`, sent as TabbyAPI `penalty_range`.
  It existed because TabbyAPI's own `-1` default maps to `int(10e7)`, spanning the whole
  sequence, and each of the 61 vocab blocks in `rep_pen.cu` walked that window in *pinned host
  memory* — ~65.5 MiB across PCIe per sampled token at 134k. `8e08af9` makes `past_ids` device-
  resident, so the kernel reads VRAM. Bounding the range is worth **+7.70% tok/s on stock and
  +0.27% on the fix** — a 96% reduction of the defect, i.e. nothing left to buy.
- **`OMP_NUM_THREADS=1`** pinned the OpenMP pool because the per-token full-sequence
  CPU→pinned memcpy in `prepare_sampling_past_ids` crossed ATen's `GRAIN_SIZE` and recruited
  all 12 threads, which then spun. `8e08af9` stages only the appended tail behind a watermark:
  1.07 MiB/token becomes 8 bytes/token, four orders of magnitude below `GRAIN_SIZE`, so the
  pool is never recruited. Decode CPU is **1.37–1.54 cores with no launch-env workaround**,
  against 11.5–11.7 on stock. The pin cost a repeatable ~1.1% of decode wall; that is now
  recovered.
- **`KMP_BLOCKTIME=1`** capped Intel OpenMP's 200 ms post-region spin. It was only ever
  mitigating the same fork/join, and was shipped unvalidated alongside the pin (no arm ever
  set both). With no parallel region to spin after, it has nothing to do.

Validation of the upstream commit — isolated against the installed 1.2.1 tree, two fixtures,
staging-invariant check — is in
[`exl3-penalty-range-upstream-fix-2026-07-30.md`](exl3-penalty-range-upstream-fix-2026-07-30.md).
The pre-fix measurements that justified the three workarounds are preserved in
[`exl3-penalty-range-validation-2026-07-30.md`](exl3-penalty-range-validation-2026-07-30.md);
read them as history, not as current guidance.

**What this costs.** Presence penalty now applies across the entire context again, including
retrieved source the model is meant to quote verbatim — the generation-quality argument that
`PenaltyRange` also served (handoff §10.1). That was a deliberate call: the field was removed
outright rather than kept on quality grounds. If repo-search output starts paraphrasing where
it used to quote, this is the first thing to re-add.

`EXL3_QC_ATTN=0` was still shipped at that point; it was removed on 2026-09-02 (see the action
items above).

## `TABBY_MODEL_VISION` — vision tower

Set from the preset field `VisionEnabled`, which is EXL3-managed only (llama.cpp reports
`Not supported by llama.cpp`, and an externally-run TabbyAPI does not own its launch flags).
`managed-tabby.ts` hashes the launch environment into its process signature, so toggling the
field restarts the engine on its own. Measured on an RTX 4090 against
`D:\personal\models\elx3\3.6_27b_4.7bpw` (Qwen3.5-27B VL):

- **890.1 MiB resident** while loaded. The tower ships BF16 and exl3 does not quantize it, so
  the model's 4.7bpw setting does not apply to it.
- **~0.1 MiB per image token** transient during encode: 31 MiB at 640×480, 89 MiB at 720p,
  207 MiB at 1080p, 366 MiB at 1440p, 828 MiB at 4K. Nothing remains allocated afterwards —
  embeddings come back on the CPU.
- Image tokens consume the preallocated KV cache at the normal rate. With 16 full-attention
  layers, 4 KV heads and head_dim 256 at `cache_mode: 8,8` that is **34 KiB per token**, so a
  1080p screenshot is 2040 tokens ≈ 68 MiB of cache and 2040 tokens of context.
- The model's `preprocessor_config.json` allows up to 16,777,216 pixels per image — 16,384
  image tokens and roughly 1.6 GiB of transient VRAM. Nothing in SiftKit or TabbyAPI clamps
  this; exllamav3 reads the cap from the model directory, and TabbyAPI exposes no `max_pixels`
  knob.

Turning the field on for a model with no `vision_config` in its `config.json` throws at preset
validation rather than letting TabbyAPI log a warning and run with vision silently off.

Prompt budgeting cannot derive image tokens from a data URI without decoding the image, so
each attachment is charged a flat `SIFT_IMAGE_TOKEN_ESTIMATE` (2048) pre-flight; the engine's
reported prompt token count remains authoritative after the request.

## `TABBY_MODEL_VISION_OFFLOAD` — vision tower in host RAM

Set from the preset field `VisionOffload` (EXL3-managed only, same reasoning as `VisionEnabled`).
It maps to TabbyAPI's `model.vision_offload`, which sets `config.infer_params.vision_pinned`
before the vision component loads: the tower lives in pinned host memory and is streamed to the
GPU per encode. Tabby ignores it while vision is off, so the field is emitted unconditionally and
only surfaced in the dashboard once `VisionEnabled` is on. Startup confirmation is the log line
`Keeping vision model weights in system RAM (vision_offload).`

Measured 2026-08-26 on an RTX 4090 against `D:\personal\models\elx3\3.8_27b_4.4bpw`, total board
memory from `nvidia-smi` (a fresh process each time, no image encoded before the reading):

- **Resident VRAM 21,294 MiB on / 22,062–22,084 MiB off** — ~780 MiB freed, matching the tower's
  BF16 footprint. Pinned host memory counts as shared GPU memory on Windows, same caveat as the
  sysmem KV cache.
- **Text decode unchanged**: 82.5 T/s on vs 81.6 T/s off (3 greedy 200-token runs each), inside
  run-to-run noise.
- **Image latency unchanged at 2.1 MP**: 4,008 ms on vs 4,148 ms off for the same screenshot and
  prompt. The streaming cost is small next to encode plus generation at this size; expect it to
  matter more for back-to-back image requests.
- **Freeze/restore keeps the pinning.** With `IdleAction: freeze`, a vision-pinned model froze to
  1,006 MiB and restored to 21,058 MiB — the tower does not come back into VRAM, and an image
  request after restore still captions correctly.

Reading total board memory right after an image request overstates residency by roughly a
gigabyte: the allocator retains the encode blocks. Compare fresh-process readings only.
