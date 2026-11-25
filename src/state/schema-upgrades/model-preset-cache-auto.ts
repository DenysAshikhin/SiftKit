import type { RuntimeDatabase } from '../database-handle.ts';
import { addMissingModelPresetFields } from './stored-model-presets.ts';

/** Schema 91 -> 92: model presets gain `CacheAuto` and `CacheContexts`; stored presets keep their manual MiB sizes. */
export function upgradeModelPresetCacheAuto(database: RuntimeDatabase): void {
  addMissingModelPresetFields(database, { CacheAuto: false, CacheContexts: 1.1 });
}
