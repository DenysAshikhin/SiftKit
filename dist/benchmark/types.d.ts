import type { RuntimeLlamaCppConfig } from '../config/index.js';
import type { SummaryClassification, SummaryRequest } from '../summary.js';
export type BenchmarkFixture = {
    Name: string;
    File: string;
    Question: string;
    Format: 'text' | 'json';
    PolicyProfile: SummaryRequest['policyProfile'];
    SourceCommand?: string;
};
export type BenchmarkRunnerOptions = {
    fixtureRoot?: string;
    outputPath?: string;
    backend?: string;
    model?: string;
    promptPrefix?: string;
    promptPrefixFile?: string;
    requestTimeoutSeconds?: number;
    llamaCppOverrides?: Pick<RuntimeLlamaCppConfig, 'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty' | 'MaxTokens'>;
};
export type BenchmarkCaseResult = {
    Prompt: string;
    Output: string | null;
    DurationMs: number;
    PolicyDecision: string;
    Classification: SummaryClassification | null;
    RawReviewRequired: boolean;
    ModelCallSucceeded: boolean;
    Error: string | null;
};
export type BenchmarkRunResult = {
    Status: 'completed' | 'failed';
    TotalDurationMs: number;
    StartedAtUtc: string;
    CompletedAtUtc: string;
    Backend: string;
    Model: string;
    FixtureRoot: string;
    OutputPath: string;
    PromptPrefix: string | null;
    CompletedFixtureCount: number;
    FatalError: string | null;
    Results: BenchmarkCaseResult[];
};
export declare const DEFAULT_REQUEST_TIMEOUT_SECONDS = 1800;
export declare const BENCHMARK_HEARTBEAT_MS = 15000;
export declare class FatalBenchmarkError extends Error {
    constructor(message: string);
}
