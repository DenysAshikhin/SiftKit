import type { RuntimeDatabase } from '../database-handle.ts';
import { addMissingModelPresetFields } from './stored-model-presets.ts';

/** Schema 92 -> 93: chat session preset snapshots gain the fields their config presets gained in 91 and 92. */
export function upgradeChatSessionPresetSnapshots(database: RuntimeDatabase): void {
  addMissingModelPresetFields(database, { SparseDraftHead: 0, CacheAuto: false, CacheContexts: 1.1 });
}
