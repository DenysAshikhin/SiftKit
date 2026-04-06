import type { SiftConfig } from './types.js';
export declare function getConfigServiceUrl(): string;
export declare function saveConfig(config: SiftConfig): Promise<SiftConfig>;
export declare function loadConfig(options?: {
    ensure?: boolean;
}): Promise<SiftConfig>;
export declare function setTopLevelConfigKey(key: string, value: unknown): Promise<SiftConfig>;
