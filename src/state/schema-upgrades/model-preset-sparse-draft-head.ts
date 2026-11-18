import type { RuntimeDatabase } from '../database-handle.ts';
import { addMissingStoredPresetFields } from './stored-model-presets.ts';

/** Schema 90 -> 91: model presets gain `SparseDraftHead`; presets stored without one keep the full draft head (0). */
export function upgradeModelPresetSparseDraftHead(database: RuntimeDatabase): void {
  addMissingStoredPresetFields(database, { SparseDraftHead: 0 });
}
