# Production EXL3 and TabbyAPI upstream audit

Evidence gathered September 7, 2026. This is an investigation handoff, not an implementation record. Upstream branches may advance after these observations.

## Requested destination

Production currently uses customized copies of both projects. The requested destination is **upstream EXL3 `dev` + upstream Tabby `main`, with no experimental zero-copy engine or model freeze/restore feature in production**.

The user explicitly requested:

- No SiftKit commands during this work.
- Investigation only; no implementation or production changes yet.
- All differences between production and the respective upstreams, including changes beyond cached-token reporting.
- Use upstream Tabby's cached-token API instead of retaining the local patch.
- Identify remaining model freeze/restore code and documentation references for later removal.
- Keep the experimental zero-copy changes out of production.
- Present the findings in chat, then save the complete handoff to this Markdown file.

No code, configuration, dependencies, or production branches were changed during the investigation. This document was created afterward at the user's request. No commits were made.

## What EXL3 and Tabby are

**EXL3 is the inference engine; TabbyAPI is the HTTP server around it.** EXL3 loads and executes quantized models using Python/C++/CUDA. Tabby handles requests, model lifecycle, templates, streaming, and usage reporting. SiftKit launches Tabby and consumes its API.

- [EXL3 upstream](https://github.com/turboderp-org/exllamav3)
- [Tabby upstream](https://github.com/theroyallab/tabbyAPI)

## Verified production inventory

| Component | Production | Current upstream target | Upstream commits missing |
|---|---|---|---:|
| EXL3 | `dev` at `c9554e9`, version `1.4.7+unified.1` | [`dev` at `a99c309`](https://github.com/turboderp-org/exllamav3/commit/a99c30994f6d9173e505254e81b0e5d784caa36e), version `1.4.8` | 20 |
| TabbyAPI | `siftkit` at `f8b2bec` | [`main` at `92198cc`](https://github.com/theroyallab/tabbyAPI/commit/92198cca1aa48f83121027f5b9058c24d7c2d894) | 23 |

Exact revisions:

| Component | Production HEAD | Shared upstream base | Observed upstream HEAD |
|---|---|---|---|
| EXL3 | `c9554e9e2a5fbac07d0007c6640b8a475042a7d9` | `c93f3c61c35ff300df49205f6f60e716172d1398` | `a99c30994f6d9173e505254e81b0e5d784caa36e` |
| TabbyAPI | `f8b2becbcf2b6f303989ffaf4e6312685bba9618` | `e37b9c921dda50ad872e3667b5ead40e49511ea9` | `92198cca1aa48f83121027f5b9058c24d7c2d894` |

Production paths:

- EXL3: `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench`
- Tabby: `C:/Users/denys/Documents/GitHub/TabbyAPI`
- Python: `C:/envs/rl313-turbo/Scripts/python.exe`
- Python version: `3.13.14`
- Installed Torch: `2.13.0+cu132`
- Tabby deployment configuration: `C:/Users/denys/Documents/GitHub/TabbyAPI/config.yml`

Both production repositories have an official `origin` and a `DenysAshikhin` fork remote. The EXL3 repository also has a `pristine` remote pointing into SiftKit's experimental copies.

The runtime database, `.siftkit/runtime.sqlite`, confirms SiftKit launches the above interpreter with `main.py` from the above Tabby directory. Python resolves EXL3 source to:

```text
D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench/exllamav3/__init__.py
```

Its compiled extension resolves separately to:

```text
C:/envs/rl313-turbo/Lib/site-packages/exllamav3_ext.cp313-win_amd64.pyd
```

The editable-install `.pth` and `direct_url.json` also point to the qbench checkout. **Changing the source checkout alone will leave the installed native binary to address.** Source/module resolution was inspected without loading a model or rebuilding the extension.

The active persisted preset is `exl3-3-6-27b-2`, model `3.8_27b_4.9bpw`, context `155000`, at `http://127.0.0.1:8098`, with `IdleAction: none` and `ExternalServerEnabled: false`. Two other presets reference `td_flash-next_4.05bpw_h6_ng6` and `3.8_27b_sc_5.00bpw_h6`; both also use `IdleAction: none`.

The [setup document](../exl3-backend-setup.md) contains stale commit/model details and a conflicting `rl313` launch command. Relevant anchors: `docs/exl3-backend-setup.md:5`, `src/config/defaults.ts:171`, `src/status-server/managed-tabby.ts:211`.

The `pristine_exle` copies and retained WSL environments are separate experimental environments, not the production source selected by the verified configuration.

## EXL3 local customizations

The complete local customization inventory is **29 tracked files**, relative to shared upstream base `c93f3c6`: 1,947 inserted and 696 deleted text lines, plus binary cache artifacts.

| Local change | Files/scope | Production disposition |
|---|---|---|
| Experimental zero-copy CPU-MoE engine | `exllamav3/model/moe_cpu_host.py`; native `exllamav3/exllamav3_ext/cpu/moe_handoff.{cu,h}` and `moe_mul1.{cpp,h}` | Remove local modifications |
| Zero-copy documentation/tests | `doc/env_vars.md`, `tests/test_moe_cpu_arena.py`, `tests/test_moe_cpu_offload.py` | Keep out of production |
| Custom qbench execution and reporting | `eval/qbench.py`; `eval/qbench/{data,engines,interactive,measure,plot}.py` | Preserve separately if still wanted for experimentation |
| qbench tests | `tests/test_qbench_{llamacpp,measure_blocking,model_cache,noise_generator,streaming}.py` | Same |
| Benchmark data/dependency | Six tracked BBEH/IFBench cache artifacts; added `accelerate` in `requirements_eval.txt` | Same |
| Quantization fix | `exllamav3/modules/quant/exl3_lib/quantize.py`, `tests/test_quant_hessian.py` | Separate customization to retire from clean production |
| Custom version | `exllamav3/version.py`: `1.4.7+unified.1` | Replace with upstream version |

### Zero-copy engine

The changes include:

- Shared, page-locked expert arenas.
- Direct arena-to-GPU transfers and GPU weight-layout conversion.
- CPU work partitioning.
- Arena cleanup, explicit layout contracts, and parent-owned chunk release.
- Linux shared-memory capacity checks.
- Streamed-prefill profiling and subsequent profiling corrections.
- Streamed-prefill threshold default changed from `16` to `8`.
- Windows memory-operation synchronization default changed from `1` to `0`.
- Replacement of the prior staging/arena behavior and associated environment documentation.

Production contains the initial rollout at `297711c` and follow-up commits `58a3101`, `a5ecc0b`, `4e98708`, and `c9554e9`. These changes remain outside upstream; [PR #341](https://github.com/turboderp-org/exllamav3/pull/341) was open and unmerged when checked through the GitHub API.

### qbench and quantization

The qbench changes include explicit model cache IDs, local/additional datasets, bounded-memory logits processing, device-specific noise generators, Transformers shard cleanup, llama.cpp API/state-reset/offloading adjustments, customized plots, and interactive histograms.

Evidence anchors, relative to the production EXL3 repository:

- `eval/qbench/data.py:91`: model cache IDs and keys.
- `eval/qbench/measure.py:24`: bounded-memory measurement blocks.
- `eval/qbench/engines.py:38`: device-specific noise generators.
- `eval/qbench/engines.py:477`: Transformers shard cleanup.
- `eval/qbench/engines.py:1153`: llama.cpp CPU-MoE options.
- `eval/qbench/engines.py:1171`: llama.cpp state clearing between rows.

The quantization fix at `exllamav3/modules/quant/exl3_lib/quantize.py:839` makes Hessian finalization reentrant and substitutes fallback quantization for non-finite calibration state. It concerns conversion tooling rather than serving existing weights.

The six tracked cache artifacts are the `.bak`, `.dat`, and `.dir` files for each of:

```text
eval/__disk_lru_cache__/fetch_bbeh_mini_test_data_git.lru
eval/__disk_lru_cache__/fetch_ifbench_test_data_git.lru
```

There is also one untracked production EXL3 artifact:

```text
eval/__disk_lru_cache__/_load_wikitext2_raw.lru
```

## EXL3 upstream changes missing from production

- Version `1.4.8` and LFM2.5 architecture support.
- Quantized DSA/DSA-on-MLA/QSA caches.
- Padded attention for non-power-of-two head dimensions.
- Removal of FlashAttention-2 integration and its installer.
- Multimodal rewind-prefill fixes, including Gemma4 non-causal spans.
- Generation-limit/requeue fixes and preservation of draft statistics across requeues.
- Scratch-allocation reuse, loader transient-memory accounting, and VRAM diagnostics.
- Standard `chunk_size` command-line argument plumbing.
- CUDA dependency configuration moving from groups to extras and build configuration changes.
- Expandable allocator segments by default, explicitly skipped on Windows.

The complete production-to-current-upstream tree difference spans **80 files**, combining removal of local changes with upstream additions: 2,923 inserted and 2,917 deleted text lines in the production-to-upstream direction, plus binary differences.

[Upstream EXL3 changes since the shared base](https://github.com/turboderp-org/exllamav3/compare/c93f3c61c35ff300df49205f6f60e716172d1398...a99c30994f6d9173e505254e81b0e5d784caa36e)

## Tabby local customizations

The complete local customization inventory is **six tracked files**, relative to shared upstream base `e37b9c9`: 335 inserted and 17 deleted text lines.

| File | Local difference |
|---|---|
| `endpoints/OAI/types/common.py` | Cached-prompt and accepted/rejected draft-token detail objects |
| `endpoints/OAI/utils/common_.py` | Populates and aggregates those counters |
| `tests/test_usage_stats.py` | Tests the local usage contract |
| `pyproject.toml` | Replaces upstream EXL3 wheel dependencies with `1.4.7+unified.1` |
| `tests/test_exl3_draft_mtp_config.py` | Regression coverage for MTP settings |
| `tests/test_exl3_env_overrides.py` | Tests `dynamic_draft` and `sysmem_kv_cache` environment settings |

There are **no remaining local backend implementation differences** from that shared upstream base. Earlier grammar-cache, drafting/cache plumbing, and draft-mode fixes are no longer separate production customizations. Tabby's tracked working tree is clean. Its ignored `config.yml` remains deployment configuration.

Local evidence anchors, relative to the production Tabby repository:

- `endpoints/OAI/types/common.py:9`: usage detail types.
- `endpoints/OAI/utils/common_.py:26`: usage counter extraction.
- `pyproject.toml:85` and `:107`: custom EXL3 pins for cu12 and cu13.

## Cached-token API migration

The user's observation is confirmed: upstream merged [PR #452](https://github.com/theroyallab/tabbyAPI/pull/452), followed by [the zero-default follow-up](https://github.com/theroyallab/tabbyAPI/commit/24d1eae).

The GitHub API reported PR #452 as merged, with merge commit `d4aeb17da331cf6ff4864457dae8786515b099ae`. The fetched upstream Git history and source contain the implementation. A cached browser rendering still showed the PR as open; the live API and fetched source were used for the conclusion.

| Counter | Upstream field | SiftKit already reads it |
|---|---|---|
| Cached prompt tokens | `usage.prompt_tokens_details.cached_tokens` | Yes |
| Accepted drafts | `usage.completion_tokens_details.accepted_prediction_tokens` | Yes |
| Rejected drafts | `usage.completion_tokens_details.rejected_prediction_tokens` | Yes |

SiftKit already calculates evaluated prompt tokens as `prompt_tokens - cached_tokens`, clamped at zero, and proposed draft tokens as accepted plus rejected. It requests `stream_options.include_usage: true`.

SiftKit evidence:

- [Usage parsing](../../src/lib/provider-helpers.ts), `src/lib/provider-helpers.ts:254`.
- Draft parsing in the same file, `src/lib/provider-helpers.ts:294`.
- [Request builder](../../src/llm-protocol/inference-request-builder.ts), `src/llm-protocol/inference-request-builder.ts:40`.
- [Tabby metrics tests](../../tests/tabby-usage-metrics.e2e.test.ts), `tests/tabby-usage-metrics.e2e.test.ts:15`.

The meaningful contract change is that upstream returns zero-filled detail objects when counters are absent; the local patch could return `null`. Upstream rounds cached-token counts and, for multiple generations sharing a prompt, takes prompt details from the first entry while summing accepted/rejected draft counters.

**No field-name migration appears necessary.** Remove the local server patch and verify SiftKit's handling of zero defaults, streaming, aggregation, and real cache hits. Existing Tabby metrics tests provide a starting point. This conclusion is based on source inspection, not a live inference test.

## Other Tabby upstream changes missing from production

- Generator recovery that preserves unaffected concurrent requests when an error is contained to one job.
- Cleanup of the previous generator when replacement is necessary.
- Richer `/props` and model metadata, including model path and vision modality.
- `/apply-template` and `/v1/apply-template` endpoints.
- Developer-role normalization and improved template-error handling.
- LFM2 tool parsing and template support.
- Template JSON serialization compatibility fixes.
- Configurable CORS and related authentication/configuration messaging.
- Logging/progress display fixes.
- Docker build fixes.
- EXL3 `1.4.8` wheel dependencies.
- `cuda_malloc_async` defaulting to false.

The complete production-to-current-upstream tree difference spans **33 files**: 1,127 inserted and 283 deleted text lines.

[Upstream Tabby changes since the shared base](https://github.com/theroyallab/tabbyAPI/compare/e37b9c921dda50ad872e3667b5ead40e49511ea9...92198cca1aa48f83121027f5b9058c24d7c2d894)

## Model freeze/restore remnants

No active model freeze/restore implementation was found in current SiftKit, production Tabby, or production EXL3 source. SiftKit's contracts permit lifecycle actions `load/unload` and idle actions `none/unload`. Evidence: [contracts](../../packages/contracts/src/config.ts), `packages/contracts/src/config.ts:29`.

### Code and tests

| Location | Remaining reference |
|---|---|
| [app-config-migrations.ts](../../src/state/migrations/app-config-migrations.ts), line 443 | `freeze-to-unload` mode and old-value conversion |
| [registry.ts](../../src/state/migrations/registry.ts), line 824 | Migration v65 invokes that conversion |
| [model-idle-action-migration.test.ts](../../tests/model-idle-action-migration.test.ts), line 456 | Old freeze fixtures, migration tests, post-migration rejection |
| [model-residency-config.test.ts](../../tests/model-residency-config.test.ts), line 37 | Rejects `IdleAction: freeze` |
| [routes-model-residency.test.ts](../../tests/routes-model-residency.test.ts), line 18 | Verifies removed freeze route is unavailable |
| [model-runtime-residency-panel.test.tsx](../../dashboard/tests/model-runtime-residency-panel.test.tsx), line 96 | Verifies no freeze UI text |

Removing the migration would also remove its ability to upgrade old freeze-containing databases; that consequence should be recorded when doing the cleanup.

### Stale bytecode and Git history

There are **12 stale bytecode files** whose corresponding feature sources are gone.

Production EXL3, relative to `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench`:

```text
exllamav3/loader/__pycache__/frozen_tensors.cpython-313.pyc
tests/__pycache__/freeze_fakes.cpython-313.pyc
tests/__pycache__/test_freeze_coverage.cpython-313-pytest-9.1.1.pyc
tests/__pycache__/test_freeze_read_ledger.cpython-313-pytest-9.1.1.pyc
tests/__pycache__/test_frozen_tensor_source.cpython-313-pytest-9.1.1.pyc
tests/__pycache__/test_linear_freeze.cpython-313-pytest-9.1.1.pyc
tests/__pycache__/test_model_freeze.cpython-313-pytest-9.1.1.pyc
tests/__pycache__/test_vision_module_freeze_roundtrip.cpython-313-pytest-9.1.1.pyc
```

Production Tabby, relative to `C:/Users/denys/Documents/GitHub/TabbyAPI`:

```text
tests/__pycache__/test_exl3_freeze_residency.cpython-313.pyc
tests/__pycache__/test_exl3_freeze_residency.cpython-313-pytest-9.1.1.pyc
tests/__pycache__/test_model_freeze_endpoints.cpython-313.pyc
tests/__pycache__/test_model_freeze_endpoints.cpython-313-pytest-9.1.1.pyc
```

Both repositories retain historical `backup/pre-freeze-removal-20260905` Git branches and associated reflogs. These are history references, not active feature code. Nothing was deleted.

### Existing documents with model-freeze references

The audit found model-freeze references in these **16 existing documents**. This handoff necessarily also records those references for the requested later cleanup.

| Document | Anchor | Reference |
|---|---|---|
| [Model residency freeze handoff](../superpowers/handoffs/2026-08-16-model-residency-freeze-handoff.md) | Line 1 | Dedicated obsolete feature handoff |
| [Dashboard freeze fixtures plan](../superpowers/plans/2026-08-16-dashboard-freeze-supported-fixtures.md) | Line 1 | Dedicated obsolete feature plan |
| [Freeze/restore coverage plan](../superpowers/plans/2026-08-20-exl3-freeze-restore-coverage.md) | Line 1 | Dedicated obsolete feature plan |
| [Tabby merge handoff](../handoff-2026-08-26-tabby-merge.md) | Line 19 | Says to retain freeze implementation/pins |
| [Tabby merge plan](../superpowers/plans/2026-08-26-tabby-upstream-merge-and-env-rename.md) | Line 20 | Same |
| [Live verification handoff](../handoff-2026-08-26-siftkit-live-verification.md) | Line 150 | Requests freeze/unfreeze validation |
| [Assistant capture backlog handoff](../handoff-2026-08-31-assistant-idle-and-capture-backlog.md) | Line 58 | Describes frozen model states |
| [Assistant residency gate plan](../superpowers/plans/2026-08-30-assistant-model-residency-gate.md) | Line 5 | Describes frozen model behavior |
| [Performance tuning](../exl3-performance-tuning-2026-07-21.md) | Line 191 | Historical freeze/pinning behavior |
| [Autosplit handoff](../exl3-autosplit-reserve-upstream-pr-2026-08-18.md) | Line 194 | Old freeze-build versions |
| [Backend-removal plan](../superpowers/plans/2026-09-01-remove-llama-backend.md) | Line 269 | Freeze guards/messages |
| [Backend-removal handoff](../handoff-2026-09-02-remove-llama-backend.md) | Line 68 | Historical freeze-test reference |
| [Production sync plan](../superpowers/plans/2026-09-05-production-exl3-tabby-upstream-sync-and-freeze-removal.md) | Line 1 | Freeze removal and zero-copy production rollout |
| [Production sync handoff](2026-09-05-production-upstream-sync-handoff.md) | Line 1 | Same |
| [Performance follow-up](2026-09-05-performance-followup-handoff.md) | Line 101 | Freeze-removal history |
| [Flash-Next engine record](2026-09-05-qwen38-flash-next-engine.md) | Line 146 | Freeze-removal history |

Unrelated occurrences such as `Object.freeze`, Python `frozenset`, and the WSL package inventory named `exl3-freeze.txt` are not model-residency remnants. Ordinary CPU-MoE offloading, host KV/recurrent caches, and vision offloading are also separate from the removed model freeze feature.

## Implementation considerations for the later production update

1. Establish clean upstream production source and rebuild/reinstall EXL3's native extension.
2. Remove the local Tabby usage patch and `+unified.1` dependency pins.
3. Replace or revise `D:/personal/models/elx3/benchmark_tools/update-exllamav3.ps1`. It currently requires the custom version, merges upstream into the existing customized `dev` branch, and rewrites external benchmark-suite pins. Relevant anchors: lines 130, 153, and 175. Its validation also runs qbench tests.
4. Prevent Tabby's release-wheel dependency installation from replacing the requested EXL3 **dev build**. Its current CUDA-13 wheel targets Torch `2.11.0`; the installed environment uses `2.13.0`. The upstream runtime version check still requires EXL3 `1.4.7` or greater, so the upstream dev source version `1.4.8` meets that check; this does not establish native binary compatibility.
5. Keep qbench/zero-copy experiments separate from production and update deployment docs accordingly. The old production rollout plan explicitly installed zero-copy, which conflicts with the user's current direction.
6. Address the identified freeze references and stale bytecode according to the requested cleanup scope.
7. Validate model load/unload, vision/MTP, cold/warm cached-token reporting, streaming, aggregation, and failure recovery. Verify zero-valued usage details and retain normal upstream CPU offloading behavior.
8. Run relevant tests, the broader applicable suite, `npm run typecheck`, and `npm run lint` when implementation occurs. Verify the actual source and extension selected by the production interpreter after installation.

SiftKit's source-based `pinned_ids_valid` compatibility marker remains present in current upstream EXL3, so inspection found no need to remove that existing preflight check for this update. Evidence: `src/inference-presets/exl3-model-capabilities.ts:75` and upstream `exllamav3/generator/job.py:305`.

## Validation and limits

The investigation used direct repository inspection, exact Git comparisons, live upstream refs, GitHub API responses, read-only selected runtime database fields, installed-package metadata, and Python module-resolution inspection. No SiftKit commands were used.

Upstream commits were fetched into temporary bare comparison repositories, leaving production branches and remote-tracking refs untouched. Local-only differences were measured against each shared upstream base; full tree differences were measured from production HEAD to the observed upstream HEAD.

No runtime tests, builds, lint, or typecheck were run during the information-only audit. No live inference or native extension ABI compatibility result is claimed. Existing unrelated workspace changes were not edited.

Tool policy rejected cleanup of the temporary comparison repositories without a specific reason. They remained at the end of the investigation:

```text
C:/Users/denys/AppData/Local/Temp/siftkit-upstream-audit-22cc710286024eb78956f909cff35a93
```

The directory contains `exl3.git` and `tabby.git`, the temporary bare comparison repositories. The rejected cleanup made no deletion. This document records that state; it does not claim the temporary directory was subsequently removed.
