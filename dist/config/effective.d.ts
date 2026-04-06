import type { NormalizationInfo, SiftConfig } from './types.js';
export declare function getDerivedMaxInputCharacters(numCtx: number, inputCharactersPerContextToken?: number): number;
export declare function getEffectiveInputCharactersPerContextToken(config: SiftConfig): number;
export declare function getEffectiveMaxInputCharacters(config: SiftConfig): number;
export declare function getChunkThresholdCharacters(config: SiftConfig): number;
export declare function resolveInputCharactersPerContextToken(): Promise<{
    value: number;
    budgetSource: string;
}>;
export declare function addEffectiveConfigProperties(config: SiftConfig, info: NormalizationInfo): Promise<SiftConfig>;
