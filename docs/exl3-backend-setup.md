# EXL3 backend setup

## Installed deployment

- TabbyAPI checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`, branch `production-upstream` tracking official `main` at `2636ef602b55b5343cf3740dd55a77f21e0a8003` (2026-10-11 deployment; adds the `disk_cache_*` memory options). Roll back with `git checkout be74bf0` (2026-09-29).
- ExLlamaV3 source: `C:\AI\exl3\dev-20261011\src`, branch `production-dev-20261026` at `8f05898`: upstream `dev` at `38a12522` (EXL3 1.6.5, 2026-10-25) plus one local commit carrying the Windows WDDM/NVML headroom patch ([#389](https://github.com/turboderp-org/exllamav3/pull/389)). The source checkout records build provenance; the runtime imports the installed wheel. Branch `production-dev-20261017` (`448f5ea7`, 1.6.3) and `production-20261011` (`a1a91a8`, 1.6.1) remain for rollback.
- Base interpreter: `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe`, installed without PATH or registry changes.
- Python: `C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe` (`3.14.7`)
- Torch: `2.14.0+cu132`; CUDA build: `13.2`
- ExLlamaV3: `1.6.5`, built 2026-10-26 with `npm run exl3:build-wheel` (12 jobs, sm_89, CUDA 13.2.2) to `C:\AI\exl3\packages\prod\8f05898\exllamav3-1.6.5-cp314-cp314-win_amd64.whl` (SHA-256 `bfe654bc…c825`; `build.json` records provenance). Its extension is `C:\AI\exl3\prod-20260924\venv-runtime\Lib\site-packages\exllamav3_ext.cp314-win_amd64.pyd` (SHA-256 `128f9a9c…aea5`). Installed into `venv` and `venv-runtime` on 2026-10-26; `pip check` clean, no dependency changes. See the 2026-10-26 validation below.
- Rollback wheels: 1.6.3 at `C:\AI\exl3\packages\prod\448f5ea\` (SHA-256 `59012262…ab50`, with `pip freeze` of both venvs and the WDDM patch as it stood), 1.6.1 at `C:\AI\exl3\packages\prod\a1a91a8\`. Restore with `pip install --no-deps --force-reinstall <wheel>` in both venvs after stopping the managed runtime.
- Presets: Swift 5 bpw `exl3-3-8-27b-5bpw` (active; no disk cache); Flash Next 3.50bpw hq Q8 `exl3-3-8-next-3-5bpw-q8`; Swift1.5 Flash Next 3.50bpw hq Q8 `exl3-swift1-5-3-8-next-3-5bpw-q8` (MTP off); Swift1.5 Flash Next 4.00bpw hq2 Q8 `exl3-swift1-5-3-8-next-4bpw-hq2-q8`. The Flash Next presets share `D:\AI\exl3-disk-cache` (51200 MiB).
- Tabby config: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Managed command: `C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe main.py`, with the Tabby checkout as its working directory and the active preset's `TABBY_*` overrides.
- API: `http://127.0.0.1:8098/v1`

Windows WDDM uses NVML dedicated-memory headroom. Linux, HIP, TCC, and integrated-GPU accounting
retain their upstream behavior. Upstream `47dc7ce` allocates persistent module state before
autosplit measures transient allocations; the custom #386 remeasurement is no longer carried.
The [September 29 deployment record](analysis/2026-09-29-production-pr389-resync.md) records the
wheel, tests, preserved tooling edits, and remaining validation limits.

The previous `C:\AI\exl3\prod` environment remains intact for rollback. The new source and runtime
environment are separate. `C:\AI\exl3\prod-20260924\venv` is build staging; use
`venv-runtime` for managed inference. `C:\python_313` is a separate unrelated interpreter.

The active Swift preset enables offloaded vision and MTP drafting up to three tokens. Tabby loads the vision tower and main model. Deployment settings come from the persisted preset; the ignored `config.yml` has older model defaults and must not be used alone to reproduce the managed deployment.

The active Swift profile uses `max_seq_len: 149000`, `cache_mode: 8,8`, `chunk_size: 1024`, no CPU-offloaded MoE experts, and MTP drafting up to three tokens. Vision is enabled and offloaded. Flash Next is saved at `max_seq_len: 165000`, Q8, 2048-token chunks, 408 CPU experts, and MTP disabled. SiftKit accepts concurrent work up to Tabby's reported capacity. The update preserved every persisted preset and engine setting.

The managed launch pins the allocator before the child imports Torch: `PYTORCH_ALLOC_CONF` and
`PYTORCH_CUDA_ALLOC_CONF` are both set to `backend:native,expandable_segments:True`, and
`TABBY_MEMORY_CUDA_MALLOC_ASYNC=false` stops Tabby installing `cudaMallocAsync`, which cannot use
expandable segments. Both allocator names carry the same value deliberately: Torch reads the first
and falls back to the second, exllamav3 inspects the second, and exllamav3's own default returns
early on Windows.

Identify presets by their model paths; labels can be misleading:

| Model directory | Context | KV cache | Chunk | CPU-MoE experts | MTP |
|---|---:|---|---:|---:|---|
| `Swift-Qwen3.8-Flash-Next-4.00bpw_sc_h6_ng6` | 165000 | Q8 (`8,8`) | 2048 | 394 of 512 per layer | Dynamic, maximum 1 |
| `Qwen3.8-Flash-Next-exl3-3.50bpw_hq_h6_ng6` (`exl3-3-8-next-3-5bpw`) | 165000 | FP16 | 2048 | 390 of 512 per layer | Dynamic, maximum 1 |
| `Qwen3.8-Flash-Next-exl3-3.50bpw_hq_h6_ng6` (`exl3-3-8-next-3-5bpw-q8`) | 165000 | Q8 (`8,8`) | 2048 | 372 of 512 per layer | Dynamic, maximum 1 |

Dedicated VRAM (Task Manager's counter, which includes other apps) must stay under 23.5 GiB under load, or WDDM slows the model sharply: at 368 experts offloaded, Q8 peaked at 23.50 GiB and prefill fell to ~350 tok/s and decode to ~7 tok/s. Measured peaks during a 46.8k-token prefill and a 512-token generation: f16 390 → 23.31 GiB (388 → 23.45); Q8 372 → 23.17 GiB (376 → 22.80, 380 → 22.43). The largest offload counts that load at all are f16 388 and Q8 368. Tune by peak, not by what loads; one expert per layer is ~101 MiB at 3.50 bpw.
| `3.8_27b_sc_5.00bpw_h6` | 155000 | Q8 (`8,8`) | 1024 | 0 (dense) | Dynamic, maximum 3 |
| `Swift-Qwen3.8-27b-5.00bpw-sc65` (active) | 149000 | Q8 (`8,8`) | 1024 | 0 (dense) | Dynamic, maximum 3 |

All saved presets enable vision with offload, set `NgramRam: false`, and reserve 4096 MiB of recurrent host cache. September 29 validation exercised the active Swift and Flash Next presets; the older 155k dense preset was preserved but not exercised.

For these dense recurrent models, each extra draft position reserves approximately 144 MiB of main-model recurrent state per parallel slot, separately from the quantized KV cache. Dynamic drafting reduces work per round but reserves memory for its configured ceiling. The 16-token draft setting failed to load at 155k/Q8; four tokens loaded successfully, and the user subsequently chose three to leave more context headroom. Context limits were not increased automatically.

Tabby loads the model folder's `chat_template.jinja`. SiftKit forwards OpenAI `tools` and `response_format` to Tabby. This Qwen template emits tool calls as `<tool_call>` XML, which SiftKit parses into the standard tool-call representation. JSON-schema output is native; when thinking is enabled, allow enough output tokens for reasoning and constrained content.

### Windows commit headroom for CPU-offloaded experts

With `EXL3_MOE_PINNED_ARENA=1` the Flash Next preset's 408 CPU experts (45.2 GiB) live in named pagefile-backed sections, which charge Windows commit up front. exllamav3 preflights each 1 GiB chunk against free commit and fails before Windows would grow the pagefile (this machine: 16 MiB initial / 64000 MiB max on `D:`, so the commit limit tracks physical RAM). A successful load takes free commit from ~76 GB to ~2 GB (arena ~45 GB, Tabby ~26 GB private, worker ~2.4 GB), so the margin is thin: on 2026-10-06 one load with 76 GB free still failed at chunk 43 with `CPU MoE pinned arena: chunk N needs 1024 MiB, but only ... of commit are available`, and the immediate retry succeeded. The same check exists in 1.5.3. Free commit (close applications) or raise the pagefile's initial size before loading.

On 2026-10-11 the desktop baseline alone held ~52 GB of commit and Flash Next ~78 GB more (arena ~46 GB, Tabby ~29 GB of which most is the WDDM charge backing its VRAM, workers ~4.5 GB), leaving ~2 GB. The CPU page cache (`CacheRam`) is one pinned mapping reserved at load, so `CacheRam` 4096 failed with `WinError 1450` (Windows' code for an uncommittable pagefile-backed section, even with 40+ GB of RAM free); 2048 fits, and loads still fail intermittently at arena chunk 42. A larger initial pagefile removes the limit without using RAM.

### Persistent disk cache

A preset's `DiskCacheDir` enables exllamav3's disk tier behind the CPU page cache, so `CacheRam` must be > 0. Pages and recurrent checkpoints go to `<dir>\<model fingerprint>\` (pages, states, `index.sqlite`), are flushed when the generator goes idle and on SiftKit's stop/switch (unload before terminate), and are read back by a later process. Presets sharing a directory must use the same `DiskCacheSizeMiB`, which budgets the whole root.

Hybrid recurrent models resume only from a stored recurrent checkpoint, and the disk tier keeps checkpoints no closer than `DiskCacheCheckpointInterval` tokens. Orchestrator parent phases share a ~2–2.5k-token prefix, so at 4096 every first parent request after a swap got 0 cached tokens; at 2048 (the chunk size) it got 2048–4096. The default is therefore 2048; keep it at or below the chunk size for orchestrator presets.

The fingerprint includes the EXL3 version (`manifest.json` → `inputs.exllamav3`), so every EXL3 upgrade starts every model cold and leaves the old folders unreadable. They still count against the root budget: at open a new folder only removes stale siblings until its current size (zero) fits, then evicts its own pages first and reclaims from siblings about 256 MiB at a time. With a full root, a new folder's budget starts near 0.1 GB and a 65k-token prompt is not retained across a switch. After an upgrade, with the managed runtime on a preset without disk cache, move or delete the folders whose manifest names the old version. On 2026-10-26 the two 1.6.3 folders (49.4 GiB) were moved to `D:\AI\exl3-disk-cache-stale-1.6.3` (delete when 1.6.3 rollback is no longer needed).

A failed engine start reports the engine's last Python exception line, for example `TabbyAPI exited unexpectedly (code=1, signal=null): RuntimeError: Insufficient VRAM in split for model and cache`. On WDDM an over-allocated load can instead surface as `RuntimeError: CUDA driver error: device not ready` (the driver could not create a GPU mapping).

Validated 2026-10-11 with `D:\AI\exl3-disk-cache` (50 GiB budget), `CacheRam` 2048 and interval 2048 on both Flash Next presets, Swift 5 bpw (no disk cache) as repo-agent/repo-search:
- A 46.8k-token prompt after a Tabby restart: 43,008 tokens from disk, 8.4 s vs 54–91 s cold.
- Orchestrator runs that swapped parent ↔ worker several times: every first parent request after a swap back reused 2048–4096 tokens; no `disk_cache_flush_failed`. Each model's folder held ~3.2 GiB afterwards.
- As orchestrator parent, Flash Next 4.00bpw/Q8 produced a valid plan in 1 of 4 runs (1 of 8 attempts); 3.50bpw hq/FP16 in 2 of 3 runs (3 of 5 attempts, no invalid payloads in other phases); 3.50bpw hq/Q8 also completed 2 of 3 runs (3 of 5 plan attempts) but had 6 invalid review/drift payloads and one run failed on a misquoted evidence line. FP16 KV is the better parent.
- Since 2026-10-12 a parent answer that fails its schema gets one repair turn constrained by `response_format: json_schema` on the cached prefix (`task_answer_repair_requested` in the transcript), and final verification retries bad citations like task review. With 3.50bpw hq/FP16 as parent: 3 of 3 runs completed, 0 parent phase retries; 3 repairs in 20 parent calls, all schema-valid.
  - With 3.50bpw hq/Q8 (372 CPU experts) as parent, the same test: 3 of 3 runs completed, 0 parent phase retries; 4 repairs in 21 parent calls, all schema-valid. FP16's repairs were wrong shapes; two of Q8's were broken JSON syntax (`Colon expected`). Neither had an invalid tool call. Peak VRAM 23,652 MiB.
  - The constraint did not slow decoding: repair turns ran at 16.7 tok/s (FP16) and 11.6 tok/s (Q8), against 10.7 and 10.8 tok/s for normal turns, which include prefill. A repair costs a full rewrite of the answer, about 2.5 minutes for a whole plan.

Validated 2026-10-26 on 1.6.5 through the managed status server (functional checks; no throughput comparison against 1.6.3):
- Swift 27B 5 bpw and Swift1.5 Flash Next 4.00bpw hq2: streaming usage with MTP counters (Flash Next 901/949 drafts accepted), `json_schema` output, a 65.6k-token prompt repeated with 65,536 `cached_tokens`, unload/load/reload. Peak VRAM (nvidia-smi) 23,140 MiB Swift, 23,644 MiB Flash Next.
- Switching Flash Next 4.00bpw hq2 ↔ 3.50bpw Q8 with the root already full of 1.6.3 folders loaded without stalls, but kept only ~0.3 GB per model (see the upgrade note above). After moving the stale folders, each switch back restored 65,536 of 65,578 prompt tokens from disk: first token ~3 s against ~28 s cold.
- Upstream EXL3 tests against the installed wheel: WDDM headroom, disk cache, tokenizer chunking, prefill scheduling, batched readback, cache edges, quantized-KV staging, GDN, sparse head: 159 passed, 17 skipped (test models or a second GPU unavailable). The full native suite was not run.

### CPU-MoE host-core affinity

Set **Tabby/EXL3 CPU threads** in **Settings → General** to choose the CPU worker count for offloaded MoE experts across managed presets. Leave it blank for EXL3's automatic selection. Save settings, then click **Restart backend** to apply. This writes `EXL3_MOE_CPU_THREADS` in `Server.Engines.Exl3.Environment`; external servers must be configured separately.

Managed launches apply an explicit count to both EXL3 and Tabby's model setting, so Tabby's config cannot override the chosen count. Blank mode removes inherited CPU-thread overrides. Restart applies the complete saved engine configuration; if startup fails, the running engine returns to its previous configuration while the saved settings remain available for correction.

With CPU-offloaded experts the worker pool pins one compute thread per physical core. Since `production-20261006` the default pool size is physical cores minus `EXL3_MOE_HOST_CORES` (default `1`): on the 7900X, 11 workers on LPs 0–20 (even), and once the worker starts the Tabby process is confined to the freed core (LPs 22–23, mask `0xC00000`). This keeps the host from preempting a pinned worker, which otherwise stalls every per-phase barrier. Flash Next decode: +15% mean without MTP (19.7 → 22.7 T/s), +26% with MTP=1 (19.6 → 24.8 T/s); see the [benchmark record](analysis/2026-10-06-exl3-host-core-affinity.md). Dense presets (no CPU experts) are unaffected. To restore the previous placement for a preset, set `EXL3_MOE_HOST_CORES=0` in `Server.Engines.Exl3.Environment`.

## Configuring a preset

In Dashboard Settings, create or edit a model preset and select `EXL3 (TabbyAPI)` as that preset's backend. Set its Tabby base URL, model path, context size, cache mode, and idle-unload delay. `IdleAction` is `none` (stay resident) or `unload` (full unload after `SleepIdleSeconds`; the next request cold-loads). Selecting the preset makes it active; there is no global backend switch.

Set `Server.Engines.Exl3.AdminApiKey` to Tabby's admin API bearer token. SiftKit uses it for readiness checks, model inspection, load, and unload, including idle wake/reload. Leave it empty only when Tabby authentication is disabled. Caller authorization on proxied inference requests remains separate.

Saving settings persists the configuration. `POST /status/restart` applies it to the managed runtime; `GET /runtime/inference` reports the applied state. A runtime switch drains active work, pauses new admission, stops or unloads the old runtime, starts and verifies the target model, then resumes admission. This preset-switch drain is separate from normal request concurrency.

Changing the engine interpreter (`Server.Engines.Exl3.PythonPath`) requires a full SiftKit status-server restart after unloading the managed model. The runtime captures engine configuration at server startup; a backend-only restart continues using the previously captured interpreter.

Tabby's per-load API supports model, context/cache size, and cache mode. Managed-only preset fields are disabled for external servers, including parallel slots, host cache budgets, speculative decoding, and vision controls. EXL3-compatible cache modes are `FP16`, `8,8`, `4,4`, `5,5`, `8,4`, and `8,5`.

When `SleepIdleSeconds` elapses, SiftKit unloads the EXL3 model while leaving Tabby running. The next chat or tokenization request reloads it before proxying. This also applies to remote callers and other SiftKit instances. `GET /v1/models` is deliberately no-wake.

## Environment notes

The production environment is a wheel install. The current wheel was built from
`C:\AI\exl3\dev-20261011\src` and installed into the independent `venv-runtime`. Keep the old
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
existing commit's build artifacts. Keep the WDDM patch as a local commit on a new branch from
`origin/dev` so the source is clean for the builder.

1.6.5 behavior changes reach the managed runtime without Tabby changes: fair prefill/decode
scheduling is on by default (`prefill_cooldown=4`), quantized-KV prefill staging is capped by
`EXL3_QC_STAGING_PAGES` (default 256), and batched speculative readback is on
(`EXL3_NO_BATCH_READBACK=1` restores the serial path). Sparse-head drafting and `draft_max_rows`
default off and Tabby does not expose them.

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

Streaming requests need `stream_options: { include_usage: true }` for the final usage object. Current Tabby `main` always returns usage for non-streaming completions. SiftKit already sends the explicit usage option.

Schema v66 validates residency in active presets, chat snapshots, benchmark configurations and benchmark cases. The former v65 conversion is removed. Databases containing obsolete actions or missing required `IdleAction` values fail before their marker advances; stored values are not rewritten. Current lifecycle actions are `load/unload`, and idle actions are `none/unload`.
