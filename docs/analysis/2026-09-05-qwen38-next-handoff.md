# Handoff: recover Flash-Next's ~1k prefill / ~28 decode performance

Stopped at the user's handoff request on 2026-09-05. **The old results were recovered from Claude transcripts and saved. They have not yet been fully reproduced today.** No benchmark is left running.

## Objective and constraints

The user wants software performance improvements for **Qwen3.8 Flash-Next**, keeping the model quantization. They explicitly excluded the 27B models. After the September 4 tests, they recalled previously achieving approximately 1000 prefill tokens/s and 28 decode tokens/s, but losing the unsaved work.

- Do not use SiftKit; the user explicitly disabled it for this investigation.
- GPU testing and stopping existing inference/GPU processes were authorized. Preserve unrelated work, particularly `docs/analysis/qwen38-next-vram-evidence-2026-09-04/` from another session.
- No commits or worktrees. Keep temporary files in one scratch directory and preserve useful evidence in the repo before cleanup.
- Follow the user's TypeScript/schema/TDD rules for any new implementation. Existing EXL3 Python benchmark programs were invoked directly; no engine source was changed.
- Current tool permissions are full access with approval policy `never`: do not supply `sandbox_permissions`.
- The current request is a handoff, not authorization to continue testing after writing it.

## Read these saved artifacts

1. [Recovered September 2 write-up](2026-09-05-qwen38-next-recovered-notes.md): original findings, exact performance table, and proposed upstream fixes.
2. [Recovered and fresh measurements](2026-09-05-qwen38-next-recovery.json): transcript provenance, historical points, fresh replay points, and completion caveats.
3. [September 4 investigation](2026-09-04-qwen38-next-performance.md) and [point data](2026-09-04-qwen38-next-performance.json): experiments using the saved **155k cache** preset.
4. [Evidence directory](qwen38-next-recovery-evidence-2026-09-05/): preserved stdout, stderr and GPU telemetry from today's replays. Logs have been normalized to UTF-8.

## What was recovered

Local Claude transcripts:

- `C:/Users/denys/.claude/projects/c--Users-denys-Documents-GitHub-SiftKit/c8279a97-13b1-4b85-9995-8a7a44aa7c6d.jsonl`
  - **Record 8**, timestamp `2026-09-02T18:48:02.327Z`: user-pasted Flash-Next benchmark output. Multiple runs show roughly **27–29 decode tokens/s**, including 28.48 at context 0 and 28.87 at context 32512. These runs used 4096 chunks and a 32768 measurement length.
- `C:/Users/denys/.claude/projects/c--Users-denys-Documents-GitHub-SiftKit/d08a0cf6-e417-423e-ba51-425a7537bd4d.jsonl`
  - **243**: prefill 1053.03 at 4096 and **1097.58 at 8192**; threshold 4, RAM embeddings.
  - **275**: prefill 1083.97 at 4096 and **1126.98 at 8192**; additionally 8 CPU staging threads.
  - **443 / 470**: SSD embeddings yielded **1047.13 / 1028.22** at 8192.
  - **507**, timestamp `2026-09-02T19:58:24.826Z`: complete original write-up, now saved verbatim in the recovered-notes document.
  - **530 / 545**: old theoretical estimates and a separate ~25 decode tokens/s measurement. The 1k prefill and ~28 decode evidence comes from separate runs; do not describe it as one verified combined run.

**Critical difference:** the old commands omitted `--cache_size`. `eval/perf.py` defaults to **32768 cache tokens**. Yesterday's study explicitly allocated **155136** and could only load 2048-token chunks at the fixed 410-expert CPU split. The old 4096-chunk result was not evidence that 4096 fits the 155k preset.

The old session primarily changed runtime settings and added diagnostic instrumentation. Its three functional code fixes were recommendations, not demonstrated installed patches. The old Ultimate Performance power plan still exists and is active; that setting was not lost.

## Hardware, engine and preset

- RTX 4090 24 GiB; driver 610.47; WDDM; PCIe 4.0 x16; existing 360 W power limit.
- Ryzen 9 7900X, 12 cores / 24 threads; 128 GiB DDR5, reported configured 5600 MT/s.
- Active power plan: Ultimate Performance, GUID `2c9a1528-a2ce-4a83-ac21-5b83cfbb8e85`. Current AC PCIe ASPM is 0; minimum CPU state is 0, maximum 100. The recovered transcript shows those same settings under that plan. Do not infer different settings from the plan name alone.
- Python: `C:/envs/rl313-turbo/Scripts/python.exe`; Python 3.13.14, PyTorch 2.13.0+cu132.
- Explicit engine import root: `C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3`, commit `f3f7e42`.
- Native extension: installed `exllamav3_ext.cp313-win_amd64.pyd`, distribution `1.4.6+unified.1`, modified September 2 at 13:15 local. Default editable Python import points elsewhere (`D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench`), so keep `PYTHONPATH` explicit.
- Model: `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`; `Qwen4ExpForConditionalGeneration`, 48 layers, 512 experts/layer, top-10 routing. Same weights in all runs. Engine reports 4.29 bpw / 6.01 head despite the checkpoint's 4.05 label.
- Saved SiftKit preset `EXL3 3.8_Next`, id `exl3-3-8-27b`: FP16 KV, context 155000/cache 155136, chunk 2048, 410 CPU experts/layer, MTP disabled, vision offloaded to host RAM. Presets are in repo-local `.siftkit/runtime.sqlite`, `app_config.server_model_presets_json`; read it read-only. Global `~/.siftkit/runtime.sqlite` is stale.

## Findings already supported

1. **Automatic PCIe probe can underestimate working bandwidth.** Old measurements showed 3.4 or 6.8 GB/s during link wake versus 26.3–26.7 GB/s after sustained warmup. Two warm-up copies plus one timed 16 MiB copy are inadequate after idle. The formula then inflates `stream_t` from 16 to 58, retaining too much work on CPU. The saved original notes include a proposed 250 ms warmup plus best-of-8 probe.
2. **Lowering streaming threshold materially improves prefill.** September 4's fully isolated 155k-cache reference was 111.22 tokens/s at 8192; threshold 1 produced **486.75 and 489.21**. This is a repeatable 4.4x gain for that tested configuration, not a machine ceiling.
3. **CPU tail scheduling is an upstream optimization candidate.** The earlier instrumentation found tail waits queued before streamed GPU batches; only the final four jobs overlapped. Moving the waits after streaming was proposed but not implemented/validated.
4. **N-gram prefetch is another candidate.** The earlier write-up found synchronous row gather at the PLE layer; token IDs are available early enough to potentially overlap it with the first layer. No such patch was installed here.
5. **The theoretical 2k/50 numbers were optimistic subsystem estimates.** Neither is an established end-to-end maximum. Use measured results and explicit assumptions.

## Today's fresh replays

| Run | Main settings | Prefill at 8192 | Decode | Status |
|---|---|---:|---|---|
| `recovered-native-32k` | Native allocator, 32k cache, 4096 chunk, threshold 4, 12 CPU threads, RAM embeddings | 715.36 | 6.64–19.99 | Exit 0; substantial desktop CPU contention observed |
| `recovered-repeat` | Same, staging threads 8, benchmark processes AboveNormal, GPU telemetry | 831.62 | 18.52–21.95 | All points emitted, stderr empty; PowerShell launcher failed to retain child exit code, so do not claim verified exit 0 |
| `recovered-full32k` | Native, 32k cache, 4096 chunk, threshold 4, staging threads 8, RAM embeddings, **32768 measurement length** | — | — | Stopped for this handoff during startup/warmup; not a completed benchmark |

During the first replay, Explorer, VS Code and Discord consumed several CPU cores. The monitored repeat still showed varying GPU clocks/P-states (examples: SM 1485–1845 MHz, memory alternating 5001/11051 MHz). These observations do **not** establish the cause of the remaining performance gap. The user was asked whether the PC could be left idle, but did not explicitly answer; do not claim the desktop was quiesced.

The allocator is another **unresolved variable**, not a proven fix: September 4 explicitly used `backend:cudaMallocAsync` to match Tabby. Historical shell commands did not set an allocator; native is inferred from the default. Today's replays explicitly used native, but changed cache/chunk/workload and had contention, so they are not an allocator A/B.

## Reproduction command to resume

Use a fresh PowerShell process and run the explicit command; keep its output in a durable evidence directory and record the real child exit code.

```powershell
$env:PYTHONPATH = 'C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUNBUFFERED = '1'
$env:PYTORCH_ALLOC_CONF = 'backend:native'
$env:EXL3_LOAD_ARENA = '1'
$env:EXL3_MOE_STREAM_T = '4'
$env:EXL3_MOE_CPU_STAGE_THREADS = '8'
& 'C:/envs/rl313-turbo/Scripts/python.exe' `
  'pristine_exle/exllamav3/eval/perf.py' `
  -m 'D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6' `
  -mcs 410 -mct 12 -cs 32768 -max_length 32768 -chunk_size 4096 -ngr
$LASTEXITCODE
```

`-max_length 8192` reproduces the old prefill study's workload; 32768 matches the older pasted decode runs. **This argument also changes token offsets**, so do not compare them as identical-content benchmarks. `-ngr` loads about 36 GiB of extra host RAM; sufficient RAM existed during our tests.

**Do not run `pristine_exle/benchmark-next-flash.ps1` blindly.** It fetches and switches both checkouts to current upstream, and its active command currently benchmarks the 27B model; the Flash-Next line is commented out. Its MTP sibling also fetches/switches. These are not stable reproduction scripts.

## Next bounded steps

1. Complete one quiet, monitored replay of the explicit historical recipe. Save CPU activity, GPU clocks, cache/chunk/workload, environment and child exit status. Stop unrelated inference processes only after identifying them; preserve desktop work.
2. If the gap persists, separate variables: native versus async with the **same** cache, chunk, token workload, embedding mode and priority. Likewise isolate cache capacity and CPU contention. Do not attribute differences from today's multi-variable runs to one setting.
3. Only after reproducing the smaller-cache result, evaluate what can transfer to the saved 155k preset. Keep the smaller-cache benchmark and production configuration clearly distinguished; do not silently shrink the saved context to claim a speed win.
4. If asked to implement upstream fixes, start with the recovered bandwidth-probe and tail-overlap evidence. Do not upgrade/rebuild/reset checkouts indiscriminately. Preserve patches and test recipes before any cleanup.

## State and validation

- No engine source, model weights, saved presets, global environment, hardware power settings or Git commits were changed.
- AboveNormal priority applied only to benchmark processes that have exited.
- The last active full32k attempt and its CPU worker were stopped for handoff. GPU memory returned to 0 MiB. No benchmark is intentionally left running.
- All useful current replay logs were copied to the evidence directory. Temporary extraction scripts are not required to resume; original transcripts are untouched.
- September 4: repeated benchmarks, normal generation smoke, `npm run typecheck` including lint passed. The full application test suite was not run; no implementation changed.
- Preserve the existing untracked September 4 artifacts and unrelated `docs/analysis/qwen38-next-vram-evidence-2026-09-04/`. All recovery/handoff artifacts are uncommitted.
