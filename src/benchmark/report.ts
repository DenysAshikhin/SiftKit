import type { BenchmarkCaseResult, BenchmarkRunResult } from './types.js';

export function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 1000) / 1000;
}

export function buildBenchmarkArtifact(options: {
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
}): BenchmarkRunResult {
  const completedAt = new Date();
  const totalDurationMs = Number(process.hrtime.bigint() - options.startedAtHr) / 1_000_000;
  return {
    Status: options.status,
    TotalDurationMs: roundDuration(totalDurationMs),
    StartedAtUtc: options.startedAt.toISOString(),
    CompletedAtUtc: completedAt.toISOString(),
    Backend: options.backend,
    Model: options.model,
    FixtureRoot: options.fixtureRoot,
    OutputPath: options.outputPath,
    PromptPrefix: options.promptPrefix ?? null,
    CompletedFixtureCount: options.results.length,
    FatalError: options.fatalError,
    Results: options.results,
  };
}
