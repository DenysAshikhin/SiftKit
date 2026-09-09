# EXL3 backend setup

## Installed deployment

- TabbyAPI checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`, branch `production-upstream` tracking official `main` at `92198cca1aa48f83121027f5b9058c24d7c2d894`.
- ExLlamaV3 source: `C:\AI\exl3\prod\src`, branch `deployment/pr341-zerocopy-on-dev`, based on official `dev` at `a35258345595ac606d32e02388e32bc9f2946c4b` with PR341's zero-copy streamed prefill re-implemented against `dev`. This tree is build provenance only; it is **not** an editable import. Per-file provenance is in `C:\AI\exl3\manifests\prod-port-manifest.md`.
- Base interpreter: `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe`, installed without PATH or registry changes.
- Python: `C:\AI\exl3\prod\venv\Scripts\python.exe` (`3.14.7`)
- Torch: `2.14.0+cu132`; CUDA build: `13.2`
- ExLlamaV3: `1.4.8`, installed as a compiled cp314 wheel; its extension is `C:\AI\exl3\prod\venv\Lib\site-packages\exllamav3_ext.cp314-win_amd64.pyd`. The venv is self-contained: no `.pth`, no editable install, no external source dependency.
- Model: `D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6`; active preset `exl3-3-8-27b`.
- Tabby config: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Managed command: `C:\AI\exl3\prod\venv\Scripts\python.exe main.py`, with the Tabby checkout as its working directory and the active preset's `TABBY_*` overrides.
- API: `http://127.0.0.1:8098/v1`

This is the only EXL3 environment on the machine. The superseded Python 3.13 environments
(`C:\envs\rl313-pr341-pr346`, `C:\envs\rl313-turbo`) and their editable source trees were removed
on 2026-09-09 after the cutover was validated, so there is no rollback environment and no second
interpreter. Their build manifests and package inventories are retained in
`C:\AI\exl3\manifests\retired-3.13-envs`, and the local-only Git history of the retired
`pristine_exle` checkouts is retained as verified bundles in
`C:\AI\exl3\manifests\pristine-exle-preservation`. `C:\python_313` is a separate global
interpreter with unrelated consumers and is deliberately untouched.

`C:\AI\exl3\baseline\{src,venv}` is a pure upstream `dev` build kept as the measurement control for
in-flight kernel work. It is not wired into SiftKit and becomes disposable once that work lands.

The active preset enables vision and MTP drafting. Tabby loads the vision tower, draft component, and main model. Deployment settings come from the persisted preset; the ignored `config.yml` has older model defaults and must not be used alone to reproduce the managed deployment.

The active profile uses `max_seq_len: 180000`, `cache_size: 180224`, `cache_mode: 8,8`, `chunk_size: 4096`, `max_batch_size: 1`, 415 CPU-offloaded MoE experts per layer, dynamic MTP drafting with one draft token, and 4096 MiB of recurrent host cache. Vision is enabled and offloaded; the n-gram table is streamed from disk. `/props` must report `total_slots: 1` and `n_ctx: 180000`. SiftKit accepts concurrent work up to Tabby's reported capacity.

The managed launch pins the allocator before the child imports Torch: `PYTORCH_ALLOC_CONF` and
`PYTORCH_CUDA_ALLOC_CONF` are both set to `backend:native,expandable_segments:True`, and
`TABBY_MEMORY_CUDA_MALLOC_ASYNC=false` stops Tabby installing `cudaMallocAsync`, which cannot use
expandable segments. Both allocator names carry the same value deliberately: Torch reads the first
and falls back to the second, exllamav3 inspects the second, and exllamav3's own default returns
early on Windows.

Identify presets by their model paths; labels can be misleading:

| Model directory | Context | KV cache | Chunk | CPU-MoE experts | MTP |
|---|---:|---|---:|---:|---|
| `td_flash-next_4.05bpw_h6_ng6` | 180000 | Q8 (`8,8`) | 4096 | 415 | Dynamic, maximum 1 |
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
`C:\AI\exl3\prod\venv`. Never apply an upstream-only update to the ported source: `prod\src`
carries a delta that upstream does not have, and `scripts/update-exllamav3.ts` deliberately
rejects dirty or divergent source. That protection must not be weakened to make the updater accept
this deployment; the updater is only usable against a clean upstream checkout such as
`C:\AI\exl3\baseline\src`.

Stop the managed runtime before rebuilding. Build with the permanent toolchain
(`C:\AI\exl3\toolchains\cuda-13.2.2`, matching Torch's `+cu132`) and the installed Visual Studio
2022 x64 environment, with `TORCH_CUDA_ARCH_LIST=8.9`:

```powershell
& C:\AI\exl3\prod\venv\Scripts\python.exe -m pip wheel --no-deps --no-build-isolation `
  --no-cache-dir --wheel-dir C:\AI\exl3\packages C:\AI\exl3\prod\src
& C:\AI\exl3\prod\venv\Scripts\python.exe -m pip install --no-deps --force-reinstall `
  C:\AI\exl3\packages\exllamav3-1.4.8-cp314-cp314-win_amd64.whl
& C:\AI\exl3\prod\venv\Scripts\python.exe -m pip check
```

Install Tabby's base project without CUDA extras when its requirements change:

```powershell
& C:\AI\exl3\prod\venv\Scripts\python.exe -m pip install --no-build-isolation --no-deps `
  C:\Users\denys\Documents\GitHub\TabbyAPI
```

Tabby's `cu12`/`cu13` extras select release EXL3/Torch wheels and must not be used: they would
replace the source-built extension and pin an older Torch. After any rebuild, verify that
`exllamav3.__file__` and `exllamav3_ext.__file__` both resolve under `C:\AI\exl3\prod\venv`, that
`pip check` is clean, and that the managed preset still loads with MTP and vision — a passing
`eval/perf.py` run alone does not prove that.

Build and validation logs, the package lock, and source/build provenance live under
`C:\AI\exl3\{logs,packages,manifests}`. The historical qbench and quantization commits remain on
the upstream EXL3 `dev` branch and are not selected. The previous Tabby customizations remain on
its historical `siftkit` branch.

## Usage and persisted residency

SiftKit consumes upstream `usage.prompt_tokens_details.cached_tokens` and `usage.completion_tokens_details.accepted_prediction_tokens` / `rejected_prediction_tokens`, including zero-filled detail objects and final streaming usage. No local Tabby reporting patch is required.

Request `stream_options: { include_usage: true }` for both streaming and non-streaming Tabby requests. SiftKit already sends this field; upstream returns `usage: null` when it is omitted.

Schema v66 validates residency in active presets, chat snapshots, benchmark configurations and benchmark cases. The former v65 conversion is removed. Databases containing obsolete actions or missing required `IdleAction` values fail before their marker advances; stored values are not rewritten. Current lifecycle actions are `load/unload`, and idle actions are `none/unload`.
