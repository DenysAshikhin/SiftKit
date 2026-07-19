# EXL3 backend validation

Validated on 2026-07-19 with an NVIDIA GeForce RTX 4090 and driver `610.47`.

## Results

- Standalone Tabby startup loaded all 67 model modules and all 3 draft modules successfully.
- Startup identified ExLlamaV3 `1.1.0`, built-in MTP, `84992` max sequence/cache tokens, and explicit vision disablement.
- `/v1/models` returned `3.6_27B`.
- A non-thinking chat request returned exactly `EXL3_OK`.
- The tokenizer measured a generated long chat input at `50,106` tokens.
- The corresponding completion succeeded with `50,112` context tokens in `41.31s`.
- After the final SiftKit build, managed Tabby encoded a fresh long input at `50,013` tokens and returned exactly `EXL3_50K_OK` at `50,024` context tokens in `36.19s`; a follow-up request then returned `SLOT_RELEASED_OK`.
- Long-context prefill was `1214.54 tokens/s`; short generation was `90.19 tokens/s`.
- MTP accepted `3 / 3` drafted tokens for the long-context request.
- `/props` reported `total_slots: 1` and `n_ctx: 84992`.
- SiftKit managed Tabby as `active=exl3`, `selected=exl3`, `state=ready`, model `3.6_27B`.
- A real `siftkit repo-search` request completed through the managed EXL3 endpoint with the expected test name and `file:line` evidence. EXL3 token preflight uses Tabby's `/v1/token/encode` endpoint, and SiftKit accepts Tabby's CRLF-delimited SSE stream.
- Final validation passed `1,307` tests with `1` skipped and `0` failures; typecheck, lint, and the production build also passed.
- Steady observed GPU allocation after load was `20,250 MiB / 24,564 MiB`.

The main KV cache is configured as `8,8` (8-bit K and V), with one batch slot, so one request KV allocation is reserved. Vision/mmproj remained disabled.

## Known measurements not claimed

Reusable prefix-cache behavior and comparative MTP-on/off benefit were not classified by this acceptance run. The configured live KV cache is not evidence of persistent prompt-prefix caching.

## Recovery

If EXL3 startup fails, inspect `.siftkit/logs/managed-tabby/latest-startup.log` and `siftkit backend status`. A successful automatic rollback leaves the requested EXL3 selection visible while restoring the prior active runtime. Select the desired working backend explicitly to clear the mismatch:

```powershell
siftkit backend use llama --wait
```
