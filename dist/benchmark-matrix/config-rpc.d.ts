import type { ConfigRecord } from './types.js';
export declare function invokeConfigGet(configUrl: string): Promise<ConfigRecord>;
export declare function invokeConfigSet(configUrl: string, config: ConfigRecord): Promise<ConfigRecord>;
export declare function getRuntimeLlamaCppConfigValue(config: ConfigRecord, key: string): unknown;
export declare function getLlamaModels(baseUrl: string): Promise<string[]>;
export declare function waitForLlamaReadiness(baseUrl: string, expectedModelId: string, timeoutSeconds?: number): Promise<string[]>;
