# EXL3 backend setup

## Installed deployment

- TabbyAPI checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`, branch `production-upstream` tracking official `main` at `92198cca1aa48f83121027f5b9058c24d7c2d894`.
- ExLlamaV3 checkout: `C:\Users\denys\Documents\GitHub\SiftKit\pristine_exle\pr341-current-dev`, branch `deployment/pr341-pr346` at `dfd22713fa31bb2a2a743e90aaf2f2ea69736645`: official `dev` (`a99c309`) merged with complete PRs #341 (`ba5473b`, page-locked expert arena) and #346 (`2f131dc`, pinned vision MLP handles).
- Python: `C:\envs\rl313-pr341-pr346\Scripts\python.exe` (`3.13.14`)
- Torch: `2.13.0+cu132`; CUDA build: `13.2`
- ExLlamaV3: `1.4.8`, editable source with its native extension rebuilt against the installed Torch/CUDA stack. Build provenance is in `C:\envs\rl313-pr341-pr346\exllamav3-build.json`.
- Model: `D:\personal\models\elx3\3.8_27b_4.9bpw`; active preset `exl3-3-6-27b-2`.
- Tabby config: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Managed command: `C:\envs\rl313-pr341-pr346\Scripts\python.exe main.py`, with the Tabby checkout as its working directory and the active preset's `TABBY_*` overrides.
- API: `http://127.0.0.1:8098/v1`

This is a temporary experimental deployment; retain the checkout and its environment while selected. The previous pristine upstream checkout at `D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench` and environment `C:\envs\rl313-turbo` are preserved for rollback. See the [deployment and validation record](analysis/2026-09-08-pr341-pr346-deployment.md).

The active preset enables vision and MTP drafting. Tabby loads the vision tower, draft component, and main model. Deployment settings come from the persisted preset; the ignored `config.yml` has older model defaults and must not be used alone to reproduce the managed deployment.

The active profile uses `max_seq_len: 155000`, `cache_size: 155136`, `cache_mode: 8,8`, `chunk_size: 512`, `max_batch_size: 1`, dynamic MTP drafting with up to three draft tokens, and 4096 MiB of recurrent host cache. Vision offload is enabled; CPU-MoE offload is disabled for this dense model. `/props` must report `total_slots: 1` and `n_ctx: 155000`. SiftKit accepts concurrent work up to Tabby's reported capacity.

Identify presets by their model paths; labels can be misleading:

| Model directory | Context | KV cache | MTP |
|---|---:|---|---|
| `3.8_27b_4.9bpw` | 155000 | Q8 (`8,8`) | Dynamic, maximum 3 |
| `3.8_27b_sc_5.00bpw_h6` | 145000 | Q8 (`8,8`) | Dynamic, maximum 3 |
| `td_flash-next_4.05bpw_h6_ng6` | 155000 | FP16 | Disabled |

The dense model files independently report quantization `bits: 4.9` and `bits: 5.0`. All presets store `SpeculativeDraftMax: 3` and `SpeculativeDynamic: true`; the Next preset's `SpeculativeEnabled: false` disables MTP regardless of those dormant fields.

Next uses `NcpuMoe: 416` with the upstream CPU-offload engine. Its former 410-expert split exhausted VRAM at the output layer under the upstream loader; moving six more experts per layer to CPU preserved its 155k context and FP16 cache. Live generation verified zero draft counters.

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

`rl313-pr341-pr346` is the selected temporary environment. `rl313-turbo` is the preserved upstream environment. The commands below maintain that upstream environment only; the updater rejects the merged experimental checkout. Install Tabby's base project without CUDA extras:

```powershell
& C:\envs\rl313-turbo\Scripts\python.exe -m pip install --no-build-isolation C:\Users\denys\Documents\GitHub\TabbyAPI
```

Tabby's `cu12`/`cu13` extras select release EXL3/Torch wheels. Those extras do not describe this source-built dev deployment. The updater deliberately uses `--no-deps --no-build-isolation` and fails if `pip check` finds unmet dependencies.

Stop the managed runtime before updating. Run from the SiftKit checkout with the existing CUDA 13.2 toolchain:

```powershell
node --experimental-strip-types scripts/update-exllamav3.ts --mode update `
  --repo D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench `
  --python C:\envs\rl313-turbo\Scripts\python.exe `
  --cuda D:\personal\models\elx3\.tmp\turbo-match\cuda-13.2.2-build\toolkit `
  --vcvars "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" `
  --scratch "$env:TEMP\exl3-production-update"
```

The updater rejects dirty or divergent source, fetches official `dev`, fast-forwards without a merge commit, and rebuilds against the installed GPU architecture. It installs the native extension into the interpreter's site-packages and records its SHA-256, source revision, import paths, and Torch/CUDA versions in `C:\envs\rl313-turbo\exllamav3-build.json`. Use the same command with `--mode verify` to verify that manifest and `pip check` without updating. Remove the caller's scratch directory after reviewing the build log.

Historical qbench and quantization commits remain on the historical EXL3 `dev` branch and are not selected. The temporary deployment adds only PRs #341 and #346 to current upstream. The previous Tabby customizations remain on its historical `siftkit` branch. The displaced untracked benchmark cache is preserved in `D:\personal\models\elx3\benchmark_tools\experimental-cache-20260908`.

## Usage and persisted residency

SiftKit consumes upstream `usage.prompt_tokens_details.cached_tokens` and `usage.completion_tokens_details.accepted_prediction_tokens` / `rejected_prediction_tokens`, including zero-filled detail objects and final streaming usage. No local Tabby reporting patch is required.

Request `stream_options: { include_usage: true }` for both streaming and non-streaming Tabby requests. SiftKit already sends this field; upstream returns `usage: null` when it is omitted.

Schema v66 validates residency in active presets, chat snapshots, benchmark configurations and benchmark cases. The former v65 conversion is removed. Databases containing obsolete actions or missing required `IdleAction` values fail before their marker advances; stored values are not rewritten. Current lifecycle actions are `load/unload`, and idle actions are `none/unload`.
