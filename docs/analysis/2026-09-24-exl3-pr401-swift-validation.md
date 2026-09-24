# EXL3 PR #401: Swift 5 bpw validation on RTX 4090

## Decision

[Turbo's comment on #401](https://github.com/turboderp-org/exllamav3/pull/401) is consistent with the code and with this machine's measurements. Close #401 as superseded by upstream [`bd5b1a3`](https://github.com/turboderp-org/exllamav3/commit/bd5b1a3eef5543cfac67f55f870e4c67264fcb1a). There is no measured basis to push back or expand the PR.

Keep the currently installed production EXL3 until a clean wheel combines current upstream `dev` with the separate Windows WDDM loader fix in #389. Do not carry the #401 static staging patch into that wheel. The #389 patch does not apply cleanly to current `dev` in `model_ls.py` and `util/memory.py`; resolve those changes and validate the resulting exact wheel before installation.

## Code and arithmetic

Qwen3.8-27B has four KV heads with dimension 256. A 256-token page staged as fp16 K and V uses `256 * 4 * 256 * 2 * 2 = 1,048,576` bytes, exactly 1 MiB. The saved 149,000-token context allocates 583 pages (149,248 tokens). The old power-of-two rule allocated 1,024 staging pages for a 140k prompt. Current `dev` caps that at the 583-page cache pool, saving **441 MiB** at peak. Its `Attention.autosplit_extra_measure` reserves that worst-case transient in the load budget without retaining the buffer. #401 holds a 583 MiB window for the life of the quantized cache. Turbo's 0.58 GB steady-allocation increase is consistent with this size after rounding; GB/GiB labeling and other allocations prevent an exact match from the printed table alone.

## Matched benchmark

The persisted, active SiftKit preset was `exl3-3-8-27b-5bpw` using `Swift-Qwen3.8-27b-5.00bpw`, 149,000 context, 149,248 cache tokens, Q8 (`8,8`), 1,024-token chunks, one slot, MTP with a maximum of three draft tokens, and offloaded vision. Hardware: RTX 4090, 24,564 MiB, driver 610.47. A diagnostic Tabby server used loopback port 8099; the saved preset and production service configuration were not changed. All successful runs processed the same **140,018 prompt tokens**, generated 39 tokens, and reported zero CUDA allocation retries or OOMs. The prompt SHA-256 was `1acb62b43c3bb916c3ecef3b53f5614c7a45f7e45f840816186fafdd463f6baf`.

| Source | Steady allocated | Peak allocated | Peak reserved | Result |
|---|---:|---:|---:|---|
| `dev` before fix, `623d197` | 21.530 GiB | 22.646 GiB | 22.701 GiB | Completed |
| Exact #401 head, `482ce08` | — | — | — | Load failed: `Insufficient VRAM in split for model and cache` |
| Current `dev`, `e3b52f4` containing `bd5b1a3` | 21.530 GiB | 22.215 GiB | 22.271 GiB | Completed |
| Installed production files: #389 plus first static-staging patch | 22.100 GiB | 22.408 GiB | 22.486 GiB | Completed |

Before-fix to current-`dev` peak allocated fell **441 MiB**, exactly the page-cap prediction; peak reserved fell 440 MiB. Installed production versus current `dev` used **583 MiB** more steady allocation, 198 MiB more peak allocation, and 220 MiB more peak reserved. The production and current-`dev` peak-allocation difference follows Turbo's approximately 0.20 GB direction. His much larger peak-reserved gap was not reproduced on this hardware. The exact #401 branch lacks our separate #389 Windows loader change, while installed production includes it; its failed load does not establish that #401 would fail when combined with #389.

The runs loaded Python source from each upstream revision through `PYTHONPATH`, with the installed production `exllamav3_ext` binary held constant. The production run imported the installed Python files directly. This controls the binary for the memory comparison and successfully exercised this model and prompt, but does not validate a rebuilt current-`dev` wheel or every newly changed upstream kernel.

## Production provenance and next gate

`C:\AI\exl3\prod\src` is at `0e8af63`, which merged a first version of the static staging patch onto #389. The installed wheel's `source.sha` remains `7940b78`, and installed `cache/quant.py` and `modules/attention_fn/triton_paged.py` differ from that wheel's members. They match the patched production source instead. The installed Python files were modified after the wheel build, so the existing wheel manifest does not fully describe the live environment.

That first static patch also predates #401's follow-up for bounded QSA staging and failed reservations. The active Swift preset exercised the ordinary quantized-cache path; this benchmark did not cover QSA or allocation failure recovery.

For a production update, start from a pinned current `dev`, add only the still-required #389 Windows loader changes, resolve the two patch conflicts, build a new cp314 wheel, and install it after the managed runtime is stopped. Verify wheel/source hashes and the saved Swift preset with 149k/Q8/MTP3/vision, including a 140k prompt. Also check the 150k Flash Next preset and the Windows WDDM load path. Keep the prior wheel for rollback. The diagnostic benchmark did not modify the installed wheel or saved preset.

SiftKit validation after writing this record: `npm run typecheck` and `npm run lint` passed; `npm run build:test` passed; `npm test` passed with 4,213 tests and 4 skipped.
