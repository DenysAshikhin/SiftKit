import type { RuntimeDatabase } from '../database-handle.ts';
import { addMissingAdmissionPresetFields } from './stored-model-presets.ts';

/** Schema 99 -> 100: only runs missed earlier steps. A run from before a setting ran with it off; a snapshot missing one reads its default. */
export function upgradeAdmittedPresetFields(database: RuntimeDatabase): void {
  addMissingAdmissionPresetFields(database, {
    ReviewerSlot: false, CacheAuto: false, CacheContexts: 1.1, DiskCacheDir: null, DiskCacheSizeMiB: 51_200, DiskCacheCheckpointInterval: 2048,
    RamDiskCache: false, RamDiskCacheGiB: 10, HybridDraftTokens: 0, SparseDraftHead: 0, UnlockAllSettings: false,
  });
}
