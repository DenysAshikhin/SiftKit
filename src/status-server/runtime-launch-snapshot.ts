import { getRuntimeMetadataValue, setRuntimeMetadataValue } from '../state/runtime-db.js';
import { z } from '../lib/zod.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import { parseJsonValueText } from '../lib/json.js';
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

// The snapshot is written by writeRuntimeLaunchSnapshot from a typed
// RuntimeLaunchSnapshot, so this trusted-boundary validator only confirms the
// stored JSON is an object whose LlamaCpp member is a nested object.
const RuntimeLaunchSnapshotSchema = z.custom<RuntimeLaunchSnapshot>((value) => {
  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success
    && typeof parsed.data.LlamaCpp === 'object'
    && parsed.data.LlamaCpp !== null
    && !Array.isArray(parsed.data.LlamaCpp);
});

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
    const result = RuntimeLaunchSnapshotSchema.safeParse(parseJsonValueText(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
