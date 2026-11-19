# RAM-disk prompt cache for exl3 presets

## Goal

Switching between two exl3 model presets (today Qwen3.8 Flash-Next and Qwen3.8 27B) keeps each model's prompt cache, so switching back does not re-prefill a 100k+ token prompt. The cache lives on a RAM disk that SiftKit creates and removes, so the high write rate does no SSD wear. The cache is lost when SiftKit stops, which is acceptable.

## Why

Every switch between presets of different models restarts TabbyAPI:

- The launch environment includes `TABBY_MODEL_MODEL_NAME`, so a different model never matches the running process's signature (`managed-tabby.ts`, `ensurePresetReady`).
- An in-process `/v1/model/load` would not help. TabbyAPI unloads the old container first (`TabbyAPI/common/model.py:241-246`). The RAM tiers belong to the old `AsyncGenerator` and are freed with it (`backends/exllamav3/model.py:1270-1317`). The presets also differ in launch-only settings (RAM tier sizes, MTP drafting).

Only TabbyAPI's disk tier outlives the process. Pages entering the RAM tier are also written to disk, and are read back when a prompt's pages are in no other tier, including in a later process. Neither preset sets `DiskCacheDir` today.

## Facts this design relies on

All are from the installed exllamav3 (`generator/disk_cache.py`) and TabbyAPI (`common/config_models.py`) code:

- **Pages:** the disk tier stores raw, uncompressed page images, 256 tokens per page. Pages are keyed by a content hash, so a prefix shared by several prompts is stored once.
- **Snapshots:** recurrent snapshots are kept along each chain of pages, at least `DiskCacheCheckpointInterval` tokens apart. A resumed prompt replays at most that many tokens.
- **Size limit per folder:** `disk_cache_dir` is a root. Each model and cache configuration gets its own subdirectory, named by a fingerprint. `disk_cache_size` is the budget of the whole root, across all of those subdirectories. When it is exceeded, the least recently used entries of that root's subdirectories are removed. Separate roots never evict each other.
- **Free-space floor:** the tier starts no new write once the file system's free space falls below 2% of its size, capped at 16 GB.
- **RAM tier required:** the disk tier needs a KV RAM tier above 0, because writes go through it.

Size of one full context, computed from `config.json` with the existing geometry code:

| Model | KV pages | Recurrent snapshots | Total |
|---|---|---|---|
| Flash-Next 3.5bpw, f16 cache, 200k | 26.6 KB/token → 5.0 GiB | 56.8 MiB each; every 2,048 tokens → 5.4 GiB | ≈ 10.4 GiB |
| 27B 5.0bpw, q8_0 cache, 180k | 37 KB/token → 6.2 GiB | 75.8 MiB each; every 4,096 tokens → 3.3 GiB | ≈ 9.5 GiB |

## Preset fields

Two new fields go in `ModelPresetSettingsShape`:

- `RamDiskCache: boolean`
  - When on, the preset's prompt cache lives on the SiftKit RAM disk.
  - The launch sets `TABBY_MEMORY_DISK_CACHE_DIR` to `<drive>:\<preset id>` and `TABBY_MEMORY_DISK_CACHE_SIZE` to `RamDiskCacheGiB × 1024`.
  - Both RAM tiers are sized automatically for `RAM_DISK_STAGING_CONTEXTS = 0.2` full contexts, using the existing `resolveCacheTierSizes`. They act as a staging area; the bulk sits on the RAM disk.
  - `CacheRam`, `CacheRecurrentRam`, `CacheAuto`, `CacheContexts`, `DiskCacheDir` and `DiskCacheSizeMiB` keep their stored values, but the launch ignores them and the form hides them.
  - `DiskCacheCheckpointInterval` still applies, and stays visible because it changes the size.
- `RamDiskCacheGiB: number`, a positive integer. This is the preset's own folder budget.

Validation, in the existing `ServerModelPresetsConfigSchema` checks:

- `RamDiskCache` together with a non-null `DiskCacheDir` is rejected: *"Model preset '<id>': RamDiskCache and DiskCacheDir are two disk caches; turn one off."*
- Model preset ids must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, the rule operation preset ids already follow. The id names the preset's folder on the RAM disk. The dashboard already generates ids this way, and every stored id matches.

**Migration.** Runtime schema 94 → 95 adds `RamDiskCache: false, RamDiskCacheGiB: 10` to every stored model preset and to every chat session's stored preset snapshot (`chat_sessions.model_preset_json`), keeping values already stored. A stored id that breaks the id rule fails the migration loudly and names the id. New presets default to `RamDiskCache: false, RamDiskCacheGiB: 10`.

## Engine settings

`Exl3EngineConfigSchema` (`Server.Engines.Exl3`) gains a `RamDisk` object:

- `ToolPath: string | null`: path to `aim_ll.exe` (Arsenal Image Mounter). Activating a preset with `RamDiskCache` while this is null fails the load: *"RAM disk cache needs Server.Engines.Exl3.RamDisk.ToolPath (aim_ll.exe)."*
- `DriveLetter: string`: one letter A–Z, default `S`. A fixed letter keeps the cache folder path known synchronously, because the preset residency key includes the launch environment. A volume on that letter that is not SiftKit's fails the load and names the letter.

Both are set in the config; the dashboard edits no engine paths today. The migration adds `RamDisk: { ToolPath: null, DriveLetter: 'S' }`.

## The RAM disk

One disk per SiftKit server:

- **Type and identity:** an Arsenal Image Mounter disk on `DriveLetter`, backed by locked memory (`-t file -o awe`, the type smol-helper uses), formatted NTFS with volume label `SiftKitCache`. SiftKit recognises the disk as its own only when both hold: the volume label is `SiftKitCache`, and the disk's friendly name starts with `Arsenal Virtual`. It never touches any other volume.
- **Required size:** `(Σ RamDiskCacheGiB + 1 GiB) / 0.98`. The sum is over all `RamDiskCache` presets in the current config; the 1 GiB covers NTFS and the cache indexes, and dividing by 0.98 leaves the 2% free-space floor. It is computed from the config at every preset load.
- **Grow-only:** `aim_ll` can extend a disk but not shrink it. A disk is never shrunk while it exists.
- **Owner marker:** after creating the disk, SiftKit writes `siftkit-owner.json` (`{ pid }`) at its root. A disk whose owner is a live process other than this server belongs to another SiftKit server, such as the stable server while a dev or test server runs. It is never removed or resized. A RAM-disk preset load fails instead: *"RAM disk S: belongs to SiftKit process <pid>."* A disk with no marker, or whose owner is dead, is a leftover.

`RamDiskDriver` (an interface on `ManagedEngineHost`) has four operations: `find()`, `create(sizeBytes, letter)`, `grow(sizeBytes)` and `remove()`. The real driver runs one PowerShell script per operation:

- **create:** `aim_ll -a -t file -o awe -s <size> -m <letter>: -p "/fs:ntfs /q /y /v:SiftKitCache"`
- **grow:** `aim_ll -e -s <size> -m <letter>:`, then `Resize-Partition` to the maximum supported size.
- **remove:** `aim_ll -d -m <letter>:`, falling back to `-D`.

**Elevation:**
- If the server process is elevated, the script runs directly.
- Otherwise it runs through `Start-Process powershell -Verb RunAs -Wait`, so Windows shows one UAC prompt per operation.
- A declined prompt, or a non-zero exit, fails that operation with the script's output in the error. Nothing falls back silently.
- `find()` needs no elevation.

## Lifecycle

All steps run inside `ManagedTabbyRuntime.ensurePresetReady` and `stopProcess`, while the engine is stopped, never under a running engine:

| Situation | Action |
|---|---|
| Activating a `RamDiskCache` preset, no disk | Create the disk at the required size, then create the preset's folder |
| Activating a `RamDiskCache` preset, disk smaller than required | Grow it. If growing fails, remove the disk and create it again at the required size (which empties it), and log the warning `ram_disk_recreated` with the reason. If creating it fails, the load fails |
| Activating a `RamDiskCache` preset, disk large enough | Keep it; every preset folder stays intact |
| Any `RamDiskCache` load | Delete folders on the disk whose name is not the id of a `RamDiskCache` preset in the config (a deleted or switched-off preset). Delete a preset's folder whose size exceeds its current `RamDiskCacheGiB` (the budget was lowered), and log the warning `ram_disk_folder_wiped` |
| Activating a preset without `RamDiskCache`, disk exists | Remove the disk once the old engine has stopped |
| SiftKit server stops (graceful shutdown) | Remove the disk once the engine has stopped. When the server is not elevated, this is a UAC prompt, which the shutdown waits for. A declined prompt is logged, and the next start removes the disk |
| SiftKit server exits abruptly (the synchronous process-exit path) | Start the elevated removal detached, without waiting. If it never runs, the next start removes the disk |
| The first engine start after the server starts, and `find()` returns a leftover disk | Remove it: a leftover from a crash or a declined UAC prompt at shutdown. A RAM-disk preset then creates a fresh one. A disk owned by another live SiftKit process is left alone |

With your two presets at 11 GiB each, the disk is about 23.5 GiB. Switching Flash-Next → 27B → Flash-Next keeps both folders, so the second Flash-Next load resumes its prompts from the RAM disk.

## Dashboard

In the model preset form:

- **A "RAM disk cache" checkbox.** When it's checked:
  - a "RAM disk size (GB)" number field is shown;
  - the CacheRam, CacheRecurrentRam, Auto-size caches, Full contexts, DiskCacheDir and DiskCacheSizeMiB controls are hidden.
- **Help text under the size field,** computed in the dashboard from the profile's `cacheGeometry`, the way Auto-size caches is today. Example: *"≈ 10.4 GiB per full 200k context: 5.0 GiB KV + 5.4 GiB of snapshots every 2,048 tokens. All RAM-disk presets share one RAM disk, sized to their total."*
- **Help text without a profile:** *"Profile the model to see its size per full context."*

`cache-sizing.ts` gains `resolveDiskCacheContextBytes(preset, geometry)`, which returns `{ kvBytes, snapshotBytes }` for one full `NumCtx` context at `DiskCacheCheckpointInterval` spacing. Both the help text and the tests use it.

## Testing

- **Engine lifecycle,** through `ManagedTabbyRuntime` with a fake launcher and a fake `RamDiskDriver` that records its calls:
  - create on first activation;
  - keep when switching between two RAM-disk presets;
  - grow when a budget rises;
  - recreate, with a warning, when growing fails;
  - fail the load when creating fails or the UAC prompt is declined;
  - remove when switching to a preset without the RAM disk;
  - remove at shutdown;
  - remove a leftover disk at startup;
  - delete stale and over-budget folders.
- **Launch environment:** a `RamDiskCache` preset launches with the RAM-disk folder, its budget and the 0.2-context staging tiers, and the stored manual cache fields have no effect.
- **Config:** the validation errors, the id rule, and the 94 → 95 migration (including chat session snapshots and a failing id).
- **Sizing:** `resolveDiskCacheContextBytes` gives the figures in the table above for the two models' geometries.
- **Dashboard:** the toggle hides and shows the right controls, and the help text appears with and without a profile.
- **Real driver:** its script text, checked as a unit, and the elevation branch, with process launch faked.
- **Live check on this machine, done once and not automated:**
  - real create, grow and remove;
  - a non-elevated server shows UAC prompts;
  - Flash-Next → 27B → Flash-Next, with TabbyAPI logging disk-cache hits on the second Flash-Next load;
  - the actual page and snapshot file sizes match the estimate within 5%;
  - the TabbyAPI process, running unelevated, can write to the folders an elevated process created.
- **Calibration on this machine (part of the live check):** find the values with which both presets keep a full-context prompt across swaps.
  - For each preset, send a prompt that fills about `NumCtx` minus the response reserve, then swap Flash-Next → 27B (also filled to a full context) → Flash-Next → 27B.
  - After each swap, re-send the same prompt plus one short turn. A survival means TabbyAPI's log reports the prompt as cached (from the RAM tier or disk), with at most `DiskCacheCheckpointInterval` tokens recomputed.
  - Record each preset's folder size after its full-context run; that is its minimum `RamDiskCacheGiB`.
  - Start from the estimate, rounded up. If a prompt does not survive, raise that preset's budget, and check whether the 0.2 staging contexts or the snapshot spacing is the limit, before raising further.
  - Set both presets to the smallest values that survive two full rounds, with 10% headroom. Write the measured sizes, values and survival evidence into a "Calibration results" section of this spec.

## Out of scope

- Keeping RAM tiers alive across an in-process model swap: TabbyAPI and exllamav3 do not support it.
- Faster switching itself: each switch still restarts TabbyAPI and loads the weights. This design saves the prefill after the switch, not the load.
- Shrinking a live disk.
- Persisting the cache across SiftKit restarts.
- A RAM disk for a non-managed (external) TabbyAPI.

## Risks

- **Growing:** extending a locked-memory (`awe`) Arsenal disk while it's mounted is untested. If it doesn't work, every rise in a budget recreates the disk, which is correct but loses the caches.
- **Small staging tiers:** a 0.2-context recurrent RAM tier keeps fewer end-of-prompt snapshots in RAM, so a resumed prompt may replay up to `DiskCacheCheckpointInterval` tokens. The live check measures this.
- **Locked memory:** the disk's memory can't be paged out. A total budget near the free RAM can leave too little for the model's CPU-offloaded experts; the help text states the disk's total size so this is visible before activating.
