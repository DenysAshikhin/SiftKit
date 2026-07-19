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

TabbyAPI/ExLlamaV3 `1.1.0` can abort generation inside Formatron/KBNF when OpenAI `tools` or `response_format` constraints are supplied for this model. The EXL3 request adapter therefore sends neither field. SiftKit keeps the tool schemas in its prompt and parses Qwen `<tool_call>` output locally. The llama.cpp backend continues to use its existing native tools and JSON-schema constraints.

## Selecting the backend

```powershell
siftkit backend status
siftkit backend use exl3 --wait
siftkit backend use llama --wait
```

The status server persists the selection. A switch requested during inference drains the active request, pauses queued admission, stops the old process, starts and verifies the target model, then resumes the queue. Target startup failure attempts one visible rollback.

## Shared-environment warning

TabbyAPI requires NumPy `2.2.6`, while the existing `gym3 0.3.3` and `procgen 0.10.7` packages in `rl310` require NumPy below 2. The environment therefore fails `pip check` for those two packages. Do not use this modified environment for Procgen validation without resolving that conflict in a separate environment. `torchvision` and `torchaudio` were removed because their older Torch build caused a native crash while importing ExLlamaV3, and vision is intentionally disabled.
