# Auto-sized RAM cache tiers

## Goal

A model preset can size its two host-RAM cache tiers, `CacheRam` (KV pages) and `CacheRecurrentRam` (recurrent-state snapshots), from the model's architecture instead of fixed MiB values. One **Auto-size caches** checkbox and one **Full contexts** number set both.

## Why

In orchestrator run b3c5c019, every worker run evicted the orchestrator's cached prompt, causing 12 cold prefills of 100–220 s (about 34 of 110 orchestrator minutes):

- The GPU pool holds one context (`NumCtx` = 200k tokens).
- The 2 GiB RAM tier holds about 87k tokens of KV.
- The 4 GiB snapshot pool holds about 73 snapshots, while a worker run makes 20–160 requests, each ending in a snapshot.

To resume a prefix without prefill, both its KV pages and a recurrent snapshot at its end must survive. Picking MiB values by hand needs the model's per-token and per-snapshot sizes, which this feature computes.

## Preset fields

- `CacheAuto: boolean`: when true, the two tiers are computed. `CacheRam` and `CacheRecurrentRam` keep their stored manual values, but launch ignores them, and the form disables them.
- `CacheContexts: number`: full contexts (`NumCtx` tokens each) to keep in RAM; must be greater than 0. Help text: *"Recommended: 1.1 for a single conversation. 1.5 when two alternate (e.g. orchestrator ↔ worker): only the idle conversation's KV moves to RAM, but its last snapshot must outlast every per-request snapshot the active one makes."*

New presets default to `CacheAuto: true, CacheContexts: 1.1`.

Schema 91 → 92 gives every stored preset `CacheAuto: false, CacheContexts: 1.1`, so existing presets behave as before. After the upgrade, the active preset (`exl3-3-8-next-3-5bpw-f16`) is switched to Auto at 1.5 through the dashboard as part of the live test, not by the migration.

Schema 92 → 93 gives each chat session's stored preset snapshot (`chat_sessions.model_preset_json`) the fields added in 91 and 92 (`SparseDraftHead: 0`, `CacheAuto: false`, `CacheContexts: 1.1`), keeping values already stored. The 90 → 91 step migrated only the config's preset list, so these snapshots had broken `GET /dashboard/chat/sessions` since then.

## Model cache geometry

`inspectModelDirectory` adds `cacheGeometry` to `ModelProfile`, read from `config.json` (`text_config` when present):

| Field | Source |
|---|---|
| `attentionLayers` | entries of `layer_types` other than `linear_attention`; all `num_hidden_layers` when `layer_types` is absent |
| `kvTokenDim` | `num_key_value_heads × head_dim` (`head_dim` defaults to `hidden_size / num_attention_heads`) |
| `mtpLayers` | `mtp_num_hidden_layers`, else `num_nextn_predict_layers`, else 0 |
| `recurrentSnapshotBytes` | sum over `linear_attention` layers of `fdim_qkv × linear_conv_kernel_dim × 2 + linear_num_value_heads × linear_key_head_dim × linear_value_head_dim × 2`, where `fdim_qkv = 2 × linear_num_key_heads × linear_key_head_dim + linear_num_value_heads × linear_value_head_dim`; 0 for models without linear attention |

This mirrors exllamav3:

- `cache/quant.py` and `cache/fp16.py`: page tensors.
- `modules/gated_delta_net.py` `get_checkpoint_size`: snapshots stored in fp16, the engine default SiftKit launches with.

When the geometry cannot be derived, `cacheGeometry` holds the reason as a string instead: a missing `config.json` key, or an architecture this does not model: MLA (`kv_lora_rank`), and any `layer_types` value other than `full_attention`, `sliding_attention`, or `linear_attention`. Sliding-window layers count as full attention, which is an upper bound.

## Sizing function

One pure function in `src/inference-presets/cache-sizing.ts` (beside `getExl3CacheModes`, which the dashboard already imports), `resolveCacheTierSizes(geometry, preset)`, returns `{ cacheRamMiB, recurrentRamMiB }`. The server uses it at launch and the dashboard uses it for display, so both show the same numbers.

- **KV bytes per token per layer**, from the cache mode `getExl3CacheModes` picks:
  - `FP16`: `4 × kvTokenDim`.
  - `k,v` bits: `kvTokenDim × (k + v) / 8 + kvTokenDim / 8` (int-packed values plus fp16 scales per 32 elements).
  - Draft modes `Q8`/`Q4` use 8,8 and 4,4.
- **KV per token** = `attentionLayers × target bytes` + (`SpeculativeEnabled` ? `mtpLayers × draft bytes` : 0). The RAM tier holds the target cache and the draft cache (`generator.py`: `tier_caches = [cache, draft_cache]`).
- **`cacheRamMiB`** = ⌈`CacheContexts × NumCtx × KV per token` / 2²⁰⌉.
- **`recurrentRamMiB`** = ⌈`CacheContexts × NumCtx / 2048`⌉ × `recurrentSnapshotBytes` / 2²⁰, rounded up; 0 without linear attention.
  - 2048 is the engine's default checkpoint spacing. A few architectures use 6144; for those, the formula over-provisions.

On the current model (12 attention layers, `kvTokenDim` 512, 1 MTP layer, f16, MTP on, 36 linear layers) at 1.5 contexts × 200k:

- KV per token = 26,624 B, so `cacheRamMiB` = 7,618 (7.4 GiB).
- 147 snapshots × 59,572,224 B, so `recurrentRamMiB` = 8,352 (8.2 GiB).

Why 1.5 suffices for two alternating conversations (exllamav3 source):

- The KV RAM tier only receives pages evicted from VRAM (`cpu_cache.py`), so it holds the idle conversation; about 1.1 contexts.
- The snapshot pool stores every checkpoint as it is made, including the active conversation's: one at the end of each request plus one per 2048 new tokens. The idle conversation's newest snapshot must outlast the active one's, so this tier tracks the active run's request count; 147 slots covers a ~100-turn worker.

## Where it applies

- **Launch:** `buildLaunchEnvironment` sets `TABBY_MEMORY_SYSMEM_KV_CACHE` and `TABBY_MEMORY_SYSMEM_RECURRENT_CACHE` from the resolved sizes when `CacheAuto` is on, and from the manual fields otherwise.
- **Validation:** the disk-cache rule "CacheRam must be above 0" holds when `CacheAuto` (because `CacheContexts` > 0) or when manual `CacheRam` > 0.
- **Dashboard:** in the model preset form:
  - the Auto checkbox and Full contexts number sit beside CacheRam and CacheRecurrentRam;
  - each field shows its computed size ("≈ 7.4 GiB") while Auto is on;
  - the manual inputs are disabled while Auto is on.

## Errors

With `CacheAuto` on and `cacheGeometry` a reason string, the following fail loudly with a message naming the model and the missing key or unsupported architecture:

- the launch;
- the form, which shows the reason in place of the computed sizes.

Saving settings does not inspect the model directory, so it does not check geometry.

There is no fallback to a guessed or manual size.

## Tests (TDD)

- **`resolveCacheTierSizes`:**
  - golden values for the current model (f16, MTP on and off) and for a quantized mode (`8,4`);
  - a dense model without linear attention (recurrent 0);
  - rounding.
- **`inspectModelDirectory`:**
  - geometry from fixture `config.json` files (hybrid, dense with `head_dim` derived, MLA, unknown layer type, and a missing key → reason strings);
  - the missing-key error.
- **Launch environment:** Auto on uses the resolved MiB, Auto off uses the manual fields, and Auto with an underivable geometry throws.
- **Contracts validation:** `CacheContexts` > 0, and the disk-cache rule with Auto.
- **Schema upgrade 91 → 92:** adds the two fields, leaves existing values alone, and is idempotent.
- **Dashboard:** the Auto checkbox disables the manual inputs, the contexts input saves, and the computed sizes show.

## Live check

1. Stop the engine.
2. Set the active preset to Auto at 1.5.
3. Restart through SiftKit.
4. Confirm:
   - the launch environment carries the computed MiB;
   - TabbyAPI starts with them;
   - the engine log's CPU page cache and recurrent cache sizes match the computed values.
