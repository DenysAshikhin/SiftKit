import { getRuntimeMetadataValue, setRuntimeMetadataValue } from '../state/runtime-db.js';
import { z } from '../lib/zod.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import { parseJsonValueText } from '../lib/json.js';
import type { RuntimeEngineConfig } from '../config/types.js';

const SNAPSHOT_KEY = 'runtime_engine_launch_snapshot';

/**
 * Snapshot of the active model preset taken when the managed engine
 * boots. The config service reads this to populate `Runtime.Engine` and the
 * active preset model, so prompt-budget math matches the server that was launched.
 */
export type RuntimeLaunchSnapshot = {
  Model: string | null;
  Engine: RuntimeEngineConfig;
};

// The snapshot is written by writeRuntimeLaunchSnapshot from a typed
// RuntimeLaunchSnapshot, so this trusted-boundary validator only confirms the
// stored JSON is an object whose Engine member is a nested object.
const RuntimeLaunchSnapshotSchema = z.custom<RuntimeLaunchSnapshot>((value) => {
  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success
    && typeof parsed.data.Engine === 'object'
    && parsed.data.Engine !== null
    && !Array.isArray(parsed.data.Engine);
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
