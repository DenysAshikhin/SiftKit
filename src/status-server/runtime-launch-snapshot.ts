import { getRuntimeMetadataValue, setRuntimeMetadataValue } from '../state/runtime-db.js';
import type { RuntimeLlamaCppConfig } from '../config/types.js';

const SNAPSHOT_KEY = 'runtime_llama_launch_snapshot';

/**
 * Snapshot of the active managed-llama preset taken when the managed server
 * boots. The config service reads this to populate `Runtime.LlamaCpp` /
 * `Runtime.Model`, so prompt-budget math matches the server that was launched.
 */
export type RuntimeLaunchSnapshot = {
  Model: string | null;
  LlamaCpp: RuntimeLlamaCppConfig;
};

export function writeRuntimeLaunchSnapshot(
  databasePath: string,
  snapshot: RuntimeLaunchSnapshot,
): void {
  setRuntimeMetadataValue(SNAPSHOT_KEY, JSON.stringify(snapshot), databasePath);
}

export function readRuntimeLaunchSnapshot(databasePath: string): RuntimeLaunchSnapshot | null {
  const raw = getRuntimeMetadataValue(SNAPSHOT_KEY, databasePath);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RuntimeLaunchSnapshot;
    if (parsed && typeof parsed === 'object' && parsed.LlamaCpp && typeof parsed.LlamaCpp === 'object') {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}
