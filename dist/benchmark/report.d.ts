import type { BenchmarkCaseResult, BenchmarkRunResult } from './types.js';
export declare function roundDuration(durationMs: number): number;
export declare function buildBenchmarkArtifact(options: {
    status: BenchmarkRunResult['Status'];
    startedAt: Date;
    backend: string;
    model: string;
    fixtureRoot: string;
    outputPath: string;
    promptPrefix: string | undefined;
    results: BenchmarkCaseResult[];
    startedAtHr: bigint;
    fatalError: string | null;
}): BenchmarkRunResult;
