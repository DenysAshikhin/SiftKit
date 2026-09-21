# EXL3 backend setup

## Installed deployment

- TabbyAPI checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`, branch `production-upstream` tracking official `main` at `53da7919d4e45c63f4acbcbbc00cbe0f60a1ce65` (2026-09-14).
- ExLlamaV3 source: `C:\AI\exl3\prod\src`, branch `production-pr389` at `7940b78`. It contains official `dev` at `8271af4` (latest fetched 2026-09-21), plus draft [#389](https://github.com/turboderp-org/exllamav3/pull/389) at `b2d2404`, including [#386](https://github.com/turboderp-org/exllamav3/pull/386). The source checkout records build provenance; the venv imports the installed wheel.
- Base interpreter: `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe`, installed without PATH or registry changes.
- Python: `C:\AI\exl3\prod\venv\Scripts\python.exe` (`3.14.7`)
- Torch: `2.14.0+cu132`; CUDA build: `13.2`
- ExLlamaV3: `1.5.1`, built with **12 workers** as `C:\AI\exl3\packages\prod\7940b78\exllamav3-1.5.1-cp314-cp314-win_amd64.whl`. Its extension is `C:\AI\exl3\prod\venv\Lib\site-packages\exllamav3_ext.cp314-win_amd64.pyd`. Previous wheels and the `production-patched` source branch remain available for rollback.
- Model: `D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6`; active preset `exl3-3-8-27b`.
- Tabby config: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Managed command: `C:\AI\exl3\prod\venv\Scripts\python.exe main.py`, with the Tabby checkout as its working directory and the active preset's `TABBY_*` overrides.
- API: `http://127.0.0.1:8098/v1`

Windows WDDM now uses NVML dedicated-memory headroom; Linux retains its CUDA query. All measuring
forwards remain enabled. The [deployment record](analysis/2026-09-21-exl3-pr389-production-deployment.md)
contains exact source/wheel hashes and validation results; the
[regression history](analysis/2026-09-21-exl3-loader-regression-history.md) identifies the upstream
changes that exposed the Windows issue. As verified on 2026-09-21, #386, #387, and #389 target
upstream `dev`; #387 is closed and superseded by upstream's portable MSVC fix `6b84a21`, included here.

This is the only EXL3 environment on the machine. The superseded Python 3.13 environments
(`C:\envs\rl313-pr341-pr346`, `C:\envs\rl313-turbo`) and their editable source trees were removed
on 2026-09-09 after the cutover was validated, so there is no rollback environment and no second
interpreter. Their manifests, preserved Git bundles, benchmarks, and logs were deleted on
2026-09-19. `C:\python_313` is a separate global interpreter with unrelated consumers and is
deliberately untouched.

The active preset enables offloaded vision and disables MTP drafting. Tabby loads the vision tower and main model. Deployment settings come from the persisted preset; the ignored `config.yml` has older model defaults and must not be used alone to reproduce the managed deployment.

The active profile uses `max_seq_len: 150000`, `cache_size: 150016`, `cache_mode: 8,8`, `chunk_size: 2048`, `max_batch_size: 1`, 411 CPU-offloaded MoE experts per layer, MTP disabled, and 4096 MiB of recurrent host cache. Vision is enabled and offloaded; the n-gram table is streamed from disk. `/props` must report `total_slots: 1` and `n_ctx: 150000`. SiftKit accepts concurrent work up to Tabby's reported capacity. Installing #389 did not change the saved preset.

The managed launch pins the allocator before the child imports Torch: `PYTORCH_ALLOC_CONF` and
`PYTORCH_CUDA_ALLOC_CONF` are both set to `backend:native,expandable_segments:True`, and
`TABBY_MEMORY_CUDA_MALLOC_ASYNC=false` stops Tabby installing `cudaMallocAsync`, which cannot use
expandable segments. Both allocator names carry the same value deliberately: Torch reads the first
and falls back to the second, exllamav3 inspects the second, and exllamav3's own default returns
early on Windows.

Identify presets by their model paths; labels can be misleading:

| Model directory | Context | KV cache | Chunk | CPU-MoE experts | MTP |
|---|---:|---|---:|---:|---|
| `td_flash-next_4.05bpw_h6_ng6` | 150000 | Q8 (`8,8`) | 2048 | 411 | Disabled |
| `3.8_27b_4.9bpw` | 155000 | Q8 (`8,8`) | 512 | 0 (dense) | Dynamic, maximum 3 |
| `3.8_27b_sc_5.00bpw_h6` | 145000 | Q8 (`8,8`) | 1024 | 0 (dense) | Dynamic, maximum 3 |

The dense model files independently report quantization `bits: 4.9` and `bits: 5.0`. All three presets enable vision with offload, stream the n-gram table from disk, and reserve 4096 MiB of recurrent host cache.

For these dense recurrent models, each extra draft position reserves approximately 144 MiB of main-model recurrent state per parallel slot, separately from the quantized KV cache. Dynamic drafting reduces work per round but reserves memory for its configured ceiling. The 16-token draft setting failed to load at 155k/Q8; four tokens loaded successfully, and the user subsequently chose three to leave more context headroom. Context limits were not increased automatically.

Tabby loads the model folder's `chat_template.jinja`. SiftKit forwards OpenAI `tools` and `response_format` to Tabby. This Qwen template emits tool calls as `<tool_call>` XML, which SiftKit parses into the standard tool-call representation. JSON-schema output is native; when thinking is enabled, allow enough output tokens for reasoning and constrained content.

## Configuring a preset

In Dashboard Settings, create or edit a model preset and select `EXL3 (TabbyAPI)` as that preset's backend. Set its Tabby base URL, model path, context size, cache mode, and idle-unload delay. `IdleAction` is `none` (stay resident) or `unload` (full unload after `SleepIdleSeconds`; the next request cold-loads). Selecting the preset makes it active; there is no global backend switch.

Set `Server.Engines.Exl3.AdminApiKey` to Tabby's admin API bearer token. SiftKit uses it for readiness checks, model inspection, load, and unload, including idle wake/reload. Leave it empty only when Tabby authentication is disabled. Caller authorization on proxied inference requests remains separate.

Saving settings persists the configuration. `POST /status/restart` applies it to the managed runtime; `GET /runtime/inference` reports the applied state. A runtime switch drains active work, pauses new admission, stops or unloads the old runtime, starts and verifies the target model, then resumes admission. This preset-switch drain is separate from normal request concurrency.

Changing the engine interpreter (`Server.Engines.Exl3.PythonPath`) requires a full SiftKit status-server restart after unloading the managed model. The runtime captures engine configuration at server startup; a backend-only restart continues using the previously captured interpreter.

Tabby's per-load API supports model, context/cache size, and cache mode. Managed-only preset fields are disabled for external servers, including parallel slots, host cache budgets, speculative decoding, and vision controls. EXL3-compatible cache modes are `FP16`, `8,8`, `4,4`, `5,5`, `8,4`, and `8,5`.

When `SleepIdleSeconds` elapses, SiftKit unloads the EXL3 model while leaving Tabby running. The next chat or tokenization request reloads it before proxying. This also applies to remote callers and other SiftKit instances. `GET /v1/models` is deliberately no-wake.

## Environment notes

The production environment is a wheel install, not an editable checkout, so updating it means
building a new cp314 wheel from an approved source revision and installing it into
`C:\AI\exl3\prod\venv`. Update `prod\src` with `git fetch origin dev`, then either fast-forward
`production-upstream` (`git merge --ff-only origin/dev`) or merge/rebase the deployed fix branch onto
`origin/dev`, retaining the required pending PRs. Stop the managed runtime, then build and install with:

```powershell
npm run exl3:build-wheel
```

`scripts/build-exllamav3-wheel.ts` requires a clean checkout whose HEAD contains `origin/dev`;
local commits merged or rebased on top (a pending upstream PR) are allowed and recorded, while dirty or
diverged trees are rejected. It builds with the permanent toolchain (`C:\AI\exl3\toolchains\cuda-13.2.2`,
matching Torch's `+cu132`), the Visual Studio 2022 x64 environment, `TORCH_CUDA_ARCH_LIST` from the
GPU, and the production npm command explicitly sets `MAX_JOBS=12` (override with
`-- --jobs N`). Direct script invocations without `--jobs` use half the logical CPU count, with a
minimum of one. Output goes to `C:\AI\exl3\packages\prod\<short-commit>\` as the wheel plus
`wheel.sha256`, `source.sha`, and `build.json` (commit, upstream base, local commits, wheel hash,
Torch/CUDA/GPU). It then `pip install --force-reinstall`s the wheel, runs `pip check`, and fails if
the installed package or extension resolves outside the venv, the version differs from
`exllamav3/version.py`, or the Torch stack changed. Build logs land in `C:\AI\exl3\staging`.

The wheel builder replaces the retired editable-install updater. It refuses to overwrite an
existing commit's build artifacts.

Install Tabby's base project without CUDA extras when its requirements change:

```powershell
& C:\AI\exl3\prod\venv\Scripts\python.exe -m pip install --no-build-isolation --no-deps `
  C:\Users\denys\Documents\GitHub\TabbyAPI
```

Tabby's `cu12`/`cu13` extras select release EXL3/Torch wheels and must not be used: they would
replace the source-built extension and pin an older Torch. After any rebuild, verify that
`exllamav3.__file__` and `exllamav3_ext.__file__` both resolve under `C:\AI\exl3\prod\venv`, that
`pip check` is clean, and that the managed preset still loads with its configured vision and speculative settings — a passing
`eval/perf.py` run alone does not prove that.

Keep the wheel, `wheel.sha256`, `source.sha`, and `build.json` together under
`C:\AI\exl3\packages\prod\<short-commit>\` for provenance and rollback. The historical qbench and
quantization commits remain on upstream EXL3 `dev`; the previous Tabby customizations remain on
its historical `siftkit` branch.

## Usage and persisted residency

SiftKit consumes upstream `usage.prompt_tokens_details.cached_tokens` and `usage.completion_tokens_details.accepted_prediction_tokens` / `rejected_prediction_tokens`, including zero-filled detail objects and final streaming usage. No local Tabby reporting patch is required.

Request `stream_options: { include_usage: true }` for both streaming and non-streaming Tabby requests. SiftKit already sends this field; upstream returns `usage: null` when it is omitted.

Schema v66 validates residency in active presets, chat snapshots, benchmark configurations and benchmark cases. The former v65 conversion is removed. Databases containing obsolete actions or missing required `IdleAction` values fail before their marker advances; stored values are not rewritten. Current lifecycle actions are `load/unload`, and idle actions are `none/unload`.
