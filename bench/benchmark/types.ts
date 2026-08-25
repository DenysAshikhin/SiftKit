import { z } from '../../src/lib/zod.js';
import {
  SummaryPolicyProfileSchema,
  type SummaryProviderId,
} from '../../src/summary/types.js';
import type { SummaryClassification } from '../../src/planner-protocol/summary-tools.js';

export const BenchmarkFixtureSchema = z.object({
  Name: z.string(),
  File: z.string(),
  Question: z.string(),
  Format: z.enum(['text', 'json']),
  PolicyProfile: SummaryPolicyProfileSchema,
  SourceCommand: z.string().optional(),
});
export type BenchmarkFixture = z.infer<typeof BenchmarkFixtureSchema>;

export type BenchmarkRunnerOptions = {
  fixtureRoot?: string;
  outputPath?: string;
  provider?: SummaryProviderId;
  model?: string;
  promptPrefix?: string;
  promptPrefixFile?: string;
  requestTimeoutSeconds?: number;
  llamaCppMaxTokens?: number;
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
  BenchmarkRunUri?: string;
  PromptPrefix: string | null;
  CompletedFixtureCount: number;
  FatalError: string | null;
  Results: BenchmarkCaseResult[];
};

export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 1800;
export const BENCHMARK_HEARTBEAT_MS = 15_000;

export class FatalBenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalBenchmarkError';
  }
}
