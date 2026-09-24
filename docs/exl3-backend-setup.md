# EXL3 backend setup

## Installed deployment

- TabbyAPI checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`, branch `production-upstream` tracking official `main` at `53da7919d4e45c63f4acbcbbc00cbe0f60a1ce65` (2026-09-14).
- ExLlamaV3 source: `C:\AI\exl3\prod-20260924\src`, branch `production-pr389-resync` at `a20bdd7`. It combines upstream `dev` at `e3b52f4` with [#389](https://github.com/turboderp-org/exllamav3/pull/389), including [#386](https://github.com/turboderp-org/exllamav3/pull/386). The source checkout records build provenance; the runtime imports the installed wheel.
- Base interpreter: `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe`, installed without PATH or registry changes.
- Python: `C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe` (`3.14.7`)
- Torch: `2.14.0+cu132`; CUDA build: `13.2`
- ExLlamaV3: `1.5.1`, built with **12 workers** as `C:\AI\exl3\packages\prod\a20bdd7\exllamav3-1.5.1-cp314-cp314-win_amd64.whl`. Its extension is `C:\AI\exl3\prod-20260924\venv-runtime\Lib\site-packages\exllamav3_ext.cp314-win_amd64.pyd`. The prior `prod` environment and wheel remain available for rollback.
- Active preset: Swift 5 bpw, `exl3-3-8-27b-5bpw`; Flash Next remains saved as `exl3-3-8-27b`.
- Tabby config: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Managed command: `C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe main.py`, with the Tabby checkout as its working directory and the active preset's `TABBY_*` overrides.
- API: `http://127.0.0.1:8098/v1`

Windows WDDM uses NVML dedicated-memory headroom; Linux retains its CUDA query. #386 subtracts
temporary CPU-MoE prefill buffers from autosplit's measured persistent allocation. Current upstream
still needs this correction for the saved Flash Next preset. The [prior deployment
record](analysis/2026-09-21-exl3-pr389-production-deployment.md) and [Swift validation
record](analysis/2026-09-24-exl3-pr401-swift-validation.md) contain earlier comparisons.

The previous `C:\AI\exl3\prod` environment remains intact for rollback. The new source and runtime
environment are separate. `C:\AI\exl3\prod-20260924\venv` is build staging; use
`venv-runtime` for managed inference. `C:\python_313` is a separate unrelated interpreter.

The active Swift preset enables offloaded vision and MTP drafting up to three tokens. Tabby loads the vision tower and main model. Deployment settings come from the persisted preset; the ignored `config.yml` has older model defaults and must not be used alone to reproduce the managed deployment.

The active Swift profile uses `max_seq_len: 149000`, `cache_mode: 8,8`, `chunk_size: 1024`, no CPU-offloaded MoE experts, and MTP drafting up to three tokens. Vision is enabled and offloaded. Flash Next is saved at `max_seq_len: 170000`, Q8, 2048-token chunks, 411 CPU experts, and MTP disabled. SiftKit accepts concurrent work up to Tabby's reported capacity. Rebuilding did not change either saved preset.

The managed launch pins the allocator before the child imports Torch: `PYTORCH_ALLOC_CONF` and
`PYTORCH_CUDA_ALLOC_CONF` are both set to `backend:native,expandable_segments:True`, and
`TABBY_MEMORY_CUDA_MALLOC_ASYNC=false` stops Tabby installing `cudaMallocAsync`, which cannot use
expandable segments. Both allocator names carry the same value deliberately: Torch reads the first
and falls back to the second, exllamav3 inspects the second, and exllamav3's own default returns
early on Windows.

Identify presets by their model paths; labels can be misleading:

| Model directory | Context | KV cache | Chunk | CPU-MoE experts | MTP |
|---|---:|---|---:|---:|---|
| `td_flash-next_4.05bpw_h6_ng6` | 170000 | Q8 (`8,8`) | 2048 | 411 | Disabled |
| `3.8_27b_4.9bpw` | 155000 | Q8 (`8,8`) | 512 | 0 (dense) | Dynamic, maximum 3 |
| `3.8_27b_sc_5.00bpw_h6` | 149000 | Q8 (`8,8`) | 1024 | 0 (dense) | Dynamic, maximum 3 |

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

The production environment is a wheel install. The current wheel was built from
`C:\AI\exl3\prod-20260924\src` and installed into the independent `venv-runtime`. Keep the old
`prod` environment intact for rollback. To rebuild, update the source from upstream `dev`,
retain the required pending PRs, stop the managed runtime, then build with:

```powershell
npm run exl3:build-wheel
```

`scripts/build-exllamav3-wheel.ts` requires a clean checkout whose HEAD contains `origin/dev`;
local commits merged or rebased on top (a pending upstream PR) are allowed and recorded, while dirty or
diverged trees are rejected. It builds with the permanent toolchain (`C:\AI\exl3\toolchains\cuda-13.2.2`,
matching Torch's `+cu132`), the Visual Studio 2022 x64 environment, `TORCH_CUDA_ARCH_LIST` from the
GPU, and the production npm command uses 12 build jobs. Direct script invocations without
`--jobs` use half the logical CPU count, with a
minimum of one. Output goes to `C:\AI\exl3\packages\prod\<short-commit>\` as the wheel plus
`wheel.sha256`, `source.sha`, and `build.json` (commit, upstream base, local commits, wheel hash,
Torch/CUDA/GPU). It installs the wheel into the selected build venv, runs `pip check`, and fails if
the installed package or extension resolves outside that venv, the version differs from
`exllamav3/version.py`, or the Torch stack changed. Build logs land in `C:\AI\exl3\staging`.

After the build passes, install its exact wheel into `venv-runtime` and run `pip check`.
The build command installs into the staging venv only; it does not change the interpreter
used by SiftKit. Validate the saved presets in `venv-runtime` before using the new wheel
for managed inference.

The wheel builder replaces the retired editable-install updater. It refuses to overwrite an
existing commit's build artifacts.

Install Tabby's base project without CUDA extras when its requirements change:

```powershell
& C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe -m pip install --no-build-isolation --no-deps `
  C:\Users\denys\Documents\GitHub\TabbyAPI
```

Tabby's `cu12`/`cu13` extras select release EXL3/Torch wheels and must not be used: they would
replace the source-built extension and pin an older Torch. After any rebuild, verify that
`exllamav3.__file__` and `exllamav3_ext.__file__` both resolve under `C:\AI\exl3\prod-20260924\venv-runtime`, that
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
