export type Metrics = {
    inputCharactersTotal: number;
    outputCharactersTotal: number;
    inputTokensTotal: number;
    outputTokensTotal: number;
    thinkingTokensTotal: number;
    promptCacheTokensTotal: number;
    promptEvalTokensTotal: number;
    requestDurationMsTotal: number;
    completedRequestCount: number;
    updatedAtUtc: string | null;
    inputCharactersPerContextToken?: number | null;
    chunkThresholdCharacters?: number | null;
};
export declare function getDefaultMetrics(): Metrics;
export declare function normalizeMetrics(input: unknown): Metrics;
export declare function readMetrics(metricsPath: string): Metrics;
export declare function writeMetrics(metricsPath: string, metrics: Metrics): void;
