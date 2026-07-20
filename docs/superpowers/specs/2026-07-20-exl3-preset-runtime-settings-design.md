# EXL3 Preset Runtime Settings Design

## Goal

Make the existing preset controls express the same user concepts for both backends while translating them to backend-specific runtime settings:

| Dashboard field | llama.cpp | Managed TabbyAPI / EXL3 |
| --- | --- | --- |
| Parallel slots | `--parallel` | `TABBY_MODEL_MAX_BATCH_SIZE` |
| UBatch size | `--ubatch-size` | `TABBY_MODEL_CHUNK_SIZE` |
| Speculative decoding enabled | llama speculative configuration | `TABBY_DRAFT_MODEL_DRAFT_MODE=mtp` or `disabled` |
| Speculative draft max | llama draft-token limit | `TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS` |

The dashboard keeps the backend-neutral labels `Parallel slots` and `UBatch size`. Translation happens at the runtime boundary.

## Root Cause

SiftKit currently treats these fields as unsupported for EXL3. Its EXL3 model-load request only sends `model_name`, `max_seq_len`, `cache_size`, and `cache_mode`.

TabbyAPI supports the requested settings in its startup configuration:

- `model.max_batch_size`
- `model.chunk_size`
- `draft_model.draft_mode=mtp`
- `draft_model.draft_num_tokens`

However, TabbyAPI's current `/v1/model/load` request schema does not expose all of them consistently. `chunk_size` is accepted, `max_batch_size` is silently discarded, and MTP request data is rejected by the stale draft-model request schema. Applying these settings through that endpoint would therefore create misleading preset behavior.

TabbyAPI already supports environment overrides for every configuration field using `TABBY_<SECTION>_<FIELD>`. Managed Tabby process startup is the reliable configuration boundary.

## Scope

This change applies process-level EXL3 settings to SiftKit-managed TabbyAPI instances. It does not modify or fork TabbyAPI.

External EXL3 servers remain constrained by their public model-load API:

- `UBatch size` may be sent as `chunk_size`.
- `Parallel slots` and MTP controls remain unavailable because SiftKit cannot change the external process configuration reliably.
- Availability messages state that managed TabbyAPI is required for process-level settings.

## Runtime Mapping

Before spawning managed TabbyAPI, SiftKit derives an immutable launch environment from the selected preset:

| Preset source | Environment override |
| --- | --- |
| Engine model root | `TABBY_MODEL_MODEL_DIR` |
| Relative model name | `TABBY_MODEL_MODEL_NAME` |
| `NumCtx` | `TABBY_MODEL_MAX_SEQ_LEN` |
| `CacheSize` | `TABBY_MODEL_CACHE_SIZE` |
| `CacheTypeK` | `TABBY_MODEL_CACHE_MODE` |
| `ParallelSlots` | `TABBY_MODEL_MAX_BATCH_SIZE` |
| `UBatchSize` | `TABBY_MODEL_CHUNK_SIZE` |
| `SpeculativeEnabled=false` | `TABBY_DRAFT_MODEL_DRAFT_MODE=disabled` |
| `SpeculativeEnabled=true`, `SpeculativeType=draft-mtp` | `TABBY_DRAFT_MODEL_DRAFT_MODE=mtp` |
| `SpeculativeDraftMax` | `TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS` |

All environment values are serialized strings. Existing unrelated TabbyAPI configuration remains intact, including `draft_cache_mode`.

An enabled EXL3 speculative configuration must use `draft-mtp`. Other speculative types fail validation instead of being silently translated.

## Managed Process Lifecycle

Managed TabbyAPI process identity includes every process-level preset value listed above. Applying a preset follows this sequence:

1. Derive the target launch environment and process identity.
2. Reuse the running process only when its identity exactly matches the target.
3. Otherwise stop the managed TabbyAPI process and start it with the target environment.
4. Wait for readiness and verify the requested model is resident.

Starting TabbyAPI with the target model, context, cache, batching, and MTP settings avoids relying on a partial post-start `/v1/model/load` mutation. Reapplying an identical preset does not restart the process.

## Dashboard Compatibility

The frontend keeps backend-neutral controls. Availability depends on the complete preset, not only its backend, because managed and external EXL3 have different capabilities.

### Enabled for managed EXL3

- `ParallelSlots`
- `UBatchSize`
- `SpeculativeEnabled`
- `SpeculativeType`, restricted to `draft-mtp`
- `SpeculativeDraftMax`

### Enabled for external EXL3

- `UBatchSize`, passed as `chunk_size` in the model-load request

### Still disabled for EXL3

| Field | Reason |
| --- | --- |
| `ExecutablePath` | TabbyAPI executable selection is engine-level. |
| `BindHost`, `Port` | Network binding is engine-level. |
| `GpuLayers` | EXL3 does not use llama.cpp GPU-layer offload. |
| `Threads`, `NcpuMoe` | No equivalent EXL3 model setting. |
| `FlashAttention` | No equivalent user-selectable EXL3 model setting. |
| `BatchSize` | No distinct EXL3 equivalent beyond `max_batch_size` and `chunk_size`. |
| `CacheRam` | No equivalent EXL3 model setting. |
| `ReasoningBudget`, `ReasoningBudgetMessage` | Prompt/model behavior, not an EXL3 runtime setting. |
| `SpeculativeDraftMin` | TabbyAPI exposes a draft-token count, not a matching minimum. |
| Detailed llama n-gram tuning fields | TabbyAPI does not expose matching semantics. |
| `SpeculativeMtpEnabled` | TabbyAPI draft modes are exclusive; it cannot combine MTP with another mode. |
| `VerboseLogging` | TabbyAPI logging is engine-level and split across several settings. |

TabbyAPI also supports standalone n-gram drafting and `ngram_match_min`, but SiftKit has no clean backend-neutral preset representation for those semantics. They remain out of scope rather than being mapped approximately.

## Validation and Errors

- Existing numeric preset validation continues to require positive values for parallel slots, UBatch size, and draft-token count.
- Managed EXL3 rejects an enabled speculative type other than `draft-mtp` before process launch.
- External EXL3 displays process-scoped controls as unavailable rather than accepting values it cannot apply.
- Startup failures retain the exact managed TabbyAPI stderr diagnostics.

## Test Strategy

Implementation proceeds test-first:

1. Add exact mapping tests for the managed EXL3 launch environment, including MTP enabled and disabled branches.
2. Add compatibility tests for llama.cpp, managed EXL3, and external EXL3 field availability.
3. Add managed-runtime lifecycle tests proving that changed process-level values restart TabbyAPI and identical values do not.
4. Add model-load adapter coverage proving external EXL3 sends `chunk_size` without claiming unsupported process-level settings.
5. Run the complete unit/integration suite, typecheck, lint, and production build.
6. With explicit authorization to start SiftKit processes, perform a live managed EXL3 launch and verify the configured maximum batch size, chunk size, and MTP startup evidence. Stop all started processes afterward.

## Non-Goals

- Patching TabbyAPI's Python request schemas.
- Rewriting `tabby_config.yml` per preset.
- Adding approximate mappings for llama.cpp-only fields.
- Adding standalone EXL3 n-gram controls.
- Preserving the current blanket `unsupported by EXL3` compatibility behavior.
