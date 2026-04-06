import type { NormalizationInfo, SiftConfig } from './types.js';
export declare function isLegacyManagedStartupScriptPath(value: unknown): boolean;
export declare function applyRuntimeCompatibilityView(config: SiftConfig): SiftConfig;
export declare function updateRuntimePaths(config: SiftConfig): SiftConfig;
export declare function toPersistedConfigObject(config: SiftConfig): Omit<SiftConfig, 'Paths' | 'Effective'>;
export declare function normalizeConfig(config: SiftConfig): {
    config: SiftConfig;
    info: NormalizationInfo;
};
