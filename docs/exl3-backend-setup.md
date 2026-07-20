# EXL3 backend setup

## Installed deployment

- TabbyAPI checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`
- TabbyAPI commit: `0158fb48d76546a6475d1d63f6cd5b90932d1d11`
- Python: `C:\envs\rl310\Scripts\python.exe` (`3.10.11`)
- Torch: `2.9.0+cu128`; CUDA build: `12.8`
- ExLlamaV3: `1.1.0+cu128.torch2.9.0`
- Model: `D:\personal\models\elx3\3.6_27B`
- Tabby config: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Managed command: `C:\envs\rl310\Scripts\python.exe main.py`, with the Tabby checkout as its working directory
- API: `http://127.0.0.1:8098/v1`

The checkpoint reports `Qwen3_5ForConditionalGeneration`, EXL3 4.00-bit `mul1` quantization, and one built-in MTP layer. It includes vision metadata, but Tabby is explicitly configured with `vision: false`; startup reports that the model has vision capabilities and vision is disabled. No mmproj or vision tower is loaded.

The Tabby profile uses `max_seq_len: 84992`, `cache_size: 84992`, main `cache_mode: 8,8`, `max_batch_size: 1`, MTP drafting, and a `Q8` draft cache. `/props` must report `total_slots: 1` and `n_ctx: 84992`. SiftKit serializes all EXL3 chat calls at the provider boundary so deferred metadata and top-level requests cannot overlap against that single cache slot.

Tabby loads the model folder's `chat_template.jinja`. SiftKit forwards OpenAI `tools` and `response_format` unchanged to both backends. This Qwen template emits tool calls as `<tool_call>` XML, which SiftKit parses locally into the standard tool-call representation. JSON-schema output is also native; when thinking is enabled, constrained content may begin only after reasoning, so the request needs enough output tokens for both.

## Configuring a preset

In Dashboard Settings, create or edit a model preset and select `EXL3 (TabbyAPI)` as that preset's backend. Set its Tabby base URL, model path, context size, cache mode, and idle-unload delay. Selecting the preset makes it active; there is no global backend switch.

Set `Server.Engines.Exl3.AdminApiKey` to Tabby's admin API bearer token. SiftKit uses it for readiness checks, model inspection, load, and unload, including idle wake/reload. Leave it empty only when Tabby authentication is disabled. Caller authorization on proxied inference requests remains separate.

The status server persists the active preset only after its runtime is ready. A selection made during inference drains the active request, pauses queued admission, stops or unloads the old runtime, starts and verifies the target model, then resumes the queue. Target startup failure restores the prior preset definition and runtime. Runtime state is available from `GET /runtime/inference`.

Tabby's per-load API supports model, context/cache size, and cache mode. The shared preset fields that have no per-preset EXL3 equivalent remain visible but disabled: executable path, bind host/port, GPU/CPU placement, batch/ubatch sizes, parallel slots, cache RAM, llama reasoning-budget controls, speculative decoding controls, flash attention, and verbose logging. EXL3-compatible cache modes are `FP16`, `8,8`, `4,4`, `5,5`, `8,4`, and `8,5`.

When `SleepIdleSeconds` elapses, SiftKit unloads the EXL3 model while leaving Tabby running. The next chat or tokenization request reloads it before proxying. This also applies to remote callers and other SiftKit instances. `GET /v1/models` is deliberately no-wake.

## Shared-environment warning

TabbyAPI requires NumPy `2.2.6`, while the existing `gym3 0.3.3` and `procgen 0.10.7` packages in `rl310` require NumPy below 2. The environment therefore fails `pip check` for those two packages. Do not use this modified environment for Procgen validation without resolving that conflict in a separate environment. `torchvision` and `torchaudio` were removed because their older Torch build caused a native crash while importing ExLlamaV3, and vision is intentionally disabled.
