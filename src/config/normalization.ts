import { initializeRuntime } from './paths.js';
import type { NormalizationInfo, SiftConfig } from './types.js';

/**
 * The status server `/config` endpoint is the authoritative normalizer
 * (see status-server/config-store.ts). The client trusts what it returns;
 * this is a passthrough kept so callers have a stable normalize entry point.
 */
export function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  return { config, info: { changed: false } };
}

export function updateRuntimePaths(config: SiftConfig): SiftConfig {
  return {
    ...config,
    Paths: initializeRuntime(),
  };
}

/** Strips derived fields (`Paths`, `Effective`) before persisting via PUT /config. */
export function toPersistedConfigObject(config: SiftConfig): Omit<SiftConfig, 'Paths' | 'Effective'> {
  const persisted = { ...config };
  delete (persisted as Partial<SiftConfig>).Paths;
  delete (persisted as Partial<SiftConfig>).Effective;
  return persisted;
}
