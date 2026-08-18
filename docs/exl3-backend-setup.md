# EXL3 backend setup

## Installed deployment

- TabbyAPI checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`, branch `siftkit` at `4d6554eb3694a013922c1b64c7bf28371df4540d`, forked from `theroyallab/tabbyAPI@0158fb48`
- ExLlamaV3 checkout: `C:\Users\denys\Documents\GitHub\exllamav3`, branch `siftkit` at `8bcc08a`, forked from upstream `dev` at `cf05532` (v1.3.0)
- Python: `C:\envs\rl313\Scripts\python.exe` (`3.13.14`)
- Torch: `2.9.0+cu128`; CUDA build: `12.8`
- ExLlamaV3: `1.3.0+siftkit.freeze`, installed from a locally built wheel under `C:\tmp\rsx\elx3_freeze\wheels`
- Model: `D:\personal\models\elx3\3.8_27b_4.6bpw`
- Tabby config: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Managed command: `C:\envs\rl313\Scripts\python.exe main.py`, with the Tabby checkout as its working directory
- API: `http://127.0.0.1:8098/v1`

The checkpoint reports `Qwen3_5ForConditionalGeneration`, EXL3 4.6-bit `mul1` quantization with `head_bits: 6`, and one built-in MTP layer. Attention is hybrid: `full_attention_interval: 4` yields 16 full-attention layers out of 64, the rest linear-attention, so the KV cache scales with 16 layers only. The active preset sets `VisionEnabled: true`, so Tabby loads the vision tower as its own component alongside the MTP draft and the main model.

The Tabby profile uses `max_seq_len: 125000`, `cache_size: 125184`, main `cache_mode: 8,8`, `max_batch_size: 1`, MTP drafting, and a `Q8` draft cache. `/props` must report `total_slots: 1` and `n_ctx: 125000`. SiftKit uses backend-aware admission: EXL3 accepts concurrent work up to the capacity reported by Tabby, while llama.cpp executes admitted requests FIFO. With this one-slot profile, Tabby itself limits execution to one active generation.

Tabby loads the model folder's `chat_template.jinja`. SiftKit forwards OpenAI `tools` and `response_format` unchanged to both backends. This Qwen template emits tool calls as `<tool_call>` XML, which SiftKit parses locally into the standard tool-call representation. JSON-schema output is also native; when thinking is enabled, constrained content may begin only after reasoning, so the request needs enough output tokens for both.

## Configuring a preset

In Dashboard Settings, create or edit a model preset and select `EXL3 (TabbyAPI)` as that preset's backend. Set its Tabby base URL, model path, context size, cache mode, and idle-unload delay. Selecting the preset makes it active; there is no global backend switch.

Set `Server.Engines.Exl3.AdminApiKey` to Tabby's admin API bearer token. SiftKit uses it for readiness checks, model inspection, load, and unload, including idle wake/reload. Leave it empty only when Tabby authentication is disabled. Caller authorization on proxied inference requests remains separate.

The status server persists the active preset only after its runtime is ready. A selection made during inference drains active work, pauses new admission, stops or unloads the old runtime, starts and verifies the target model, then resumes admission. This preset-switch drain is separate from normal request concurrency. Target startup failure restores the prior preset definition and runtime. Runtime state is available from `GET /runtime/inference`.

Tabby's per-load API supports model, context/cache size, and cache mode. The shared preset fields that have no per-preset EXL3 equivalent remain visible but disabled: executable path, bind host/port, GPU/CPU placement, batch/ubatch sizes, parallel slots, cache RAM, llama reasoning-budget controls, speculative decoding controls, flash attention, and verbose logging. EXL3-compatible cache modes are `FP16`, `8,8`, `4,4`, `5,5`, `8,4`, and `8,5`.

When `SleepIdleSeconds` elapses, SiftKit unloads the EXL3 model while leaving Tabby running. The next chat or tokenization request reloads it before proxying. This also applies to remote callers and other SiftKit instances. `GET /v1/models` is deliberately no-wake.

## Environment notes

`rl313` is dedicated to the engine and carries NumPy `2.2.6` as TabbyAPI requires. `torchvision` and `torchaudio` are not installed; an older Torch build of those caused a native crash while importing ExLlamaV3.
