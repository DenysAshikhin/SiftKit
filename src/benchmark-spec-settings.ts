import type { DashboardConfig, RunRecord } from '../dashboard/src/types';
import {
  getAcceptanceRate,
  getGenerationTokensPerSecond,
  getPromptCacheHitRate,
  getPromptTokensPerSecond,
} from './lib/telemetry-metrics.js';

export type SpecBenchmarkCase = {
  speculativeEnabled?: boolean;
  speculativeNgramSizeN: number;
  speculativeNgramSizeM: number;
  speculativeNgramMinHits: number;
  speculativeDraftMax: number;
  speculativeDraftMin: number;
};

export type SpecLogTotals = {
  speculative: boolean;
  checkpointed: boolean;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  rawAcceptanceLine: string | null;
};

export type SpecBenchmarkRunMetrics = {
  promptCacheTokens: number;
  promptEvalTokens: number;
  cacheHitRate: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  acceptanceRate: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  outputTokens: number;
  thinkingTokens: number;
  generationDurationMs: number | null;
};

export const DEFAULT_SPEC_BENCHMARK_CASES: SpecBenchmarkCase[] = [
  { speculativeNgramSizeN: 16, speculativeNgramSizeM: 48, speculativeNgramMinHits: 1, speculativeDraftMax: 32, speculativeDraftMin: 2 },
  { speculativeNgramSizeN: 16, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 16, speculativeNgramSizeM: 96, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 48, speculativeNgramMinHits: 1, speculativeDraftMax: 48, speculativeDraftMin: 2 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 96, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 32, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 32, speculativeNgramSizeM: 96, speculativeNgramMinHits: 3, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 3, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 8 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 32, speculativeNgramMinHits: 2, speculativeDraftMax: 32, speculativeDraftMin: 4 },
  { speculativeEnabled: false, speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
];

export const FOCUSED_SPEC_BENCHMARK_CASES: SpecBenchmarkCase[] = [
  { speculativeEnabled: false, speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 56, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 72, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 80, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 2 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 8 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 48, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 80, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 32, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
];

export const FOCUSED3_SPEC_BENCHMARK_CASES: SpecBenchmarkCase[] = [
  { speculativeEnabled: false, speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 80, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 72, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 72, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 88, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 80, speculativeNgramMinHits: 2, speculativeDraftMax: 56, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 80, speculativeNgramMinHits: 2, speculativeDraftMax: 72, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 80, speculativeNgramMinHits: 2, speculativeDraftMax: 80, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 72, speculativeNgramMinHits: 2, speculativeDraftMax: 72, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 32, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: -1, speculativeNgramMinHits: -1, speculativeDraftMax: 48, speculativeDraftMin: 12 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: -1, speculativeNgramMinHits: -1, speculativeDraftMax: 64, speculativeDraftMin: 48 },
];

function readTime(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function readNonNegativeNumber(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;
}

function readOptionalNonNegativeNumber(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

export function buildBenchmarkCaseId(entry: SpecBenchmarkCase): string {
  if (entry.speculativeEnabled === false) {
    return 'baseline-no-spec';
  }
  return `${buildBenchmarkCaseIdPart('n', entry.speculativeNgramSizeN)}-${buildBenchmarkCaseIdPart('m', entry.speculativeNgramSizeM)}-${buildBenchmarkCaseIdPart('h', entry.speculativeNgramMinHits)}-${buildBenchmarkCaseIdPart('dmax', entry.speculativeDraftMax)}-${buildBenchmarkCaseIdPart('dmin', entry.speculativeDraftMin)}`;
}

function buildBenchmarkCaseIdPart(prefix: string, value: number): string {
  return value === -1 ? `${prefix}unset` : `${prefix}${value}`;
}

export function findBenchmarkRun(runs: RunRecord[], prompt: string, startedAtUtc: string): RunRecord | null {
  const startedAt = readTime(startedAtUtc);
  const expectedPrompt = String(prompt || '').trim();
  return [...runs]
    .filter((run) => run && (run.kind === 'repo_search' || run.kind === 'repo-search'))
    .filter((run) => String(run.title || '').trim() === expectedPrompt)
    .filter((run) => Math.max(readTime(run.startedAtUtc), readTime(run.finishedAtUtc)) >= startedAt)
    .sort((left, right) => (
      Math.max(readTime(left.startedAtUtc), readTime(left.finishedAtUtc))
      - Math.max(readTime(right.startedAtUtc), readTime(right.finishedAtUtc))
    ))
    .at(0) ?? null;
}

export function getLatestSpeculativeTotalsFromLogText(text: string): SpecLogTotals {
  const normalizedText = String(text || '');
  const statsMatches = [...normalizedText.matchAll(
    /^\s*(?:llama_decode:\s+)?statistics\s+\S+:\s+.*?#gen tokens\s*=\s*(\d+),\s+#acc tokens\s*=\s*(\d+)/gimu
  )];
  const latestStats = statsMatches.at(-1);
  const acceptanceMatches = [...normalizedText.matchAll(/^\s*(?:llama_decode:\s+)?draft acceptance rate\s*=.*$/gimu)];
  return {
    speculative: /"speculative"\s*:\s*true/iu.test(normalizedText),
    checkpointed: /speculative decoding will use checkpoints/iu.test(normalizedText),
    speculativeGeneratedTokens: latestStats ? Number.parseInt(latestStats[1], 10) : null,
    speculativeAcceptedTokens: latestStats ? Number.parseInt(latestStats[2], 10) : null,
    rawAcceptanceLine: acceptanceMatches.at(-1)?.[0] ?? null,
  };
}

export function getSpeculativeLogDeltaTotals(
  current: SpecLogTotals,
  baseline: SpecLogTotals | null,
): SpecLogTotals {
  const currentAccepted = current.speculativeAcceptedTokens;
  const currentGenerated = current.speculativeGeneratedTokens;
  const baselineAccepted = baseline?.speculativeAcceptedTokens ?? null;
  const baselineGenerated = baseline?.speculativeGeneratedTokens ?? null;
  if (
    currentAccepted === null
    || currentGenerated === null
    || baselineAccepted === null
    || baselineGenerated === null
  ) {
    return current;
  }
  if (currentAccepted < baselineAccepted || currentGenerated < baselineGenerated) {
    return current;
  }
  return {
    speculative: current.speculative,
    checkpointed: current.checkpointed,
    speculativeAcceptedTokens: currentAccepted - baselineAccepted,
    speculativeGeneratedTokens: currentGenerated - baselineGenerated,
    rawAcceptanceLine: current.rawAcceptanceLine,
  };
}

export function getRunTelemetryStats(
  run: RunRecord | null,
  speculativeLogMetrics: SpecLogTotals | null = null,
): SpecBenchmarkRunMetrics {
  const promptCacheTokens = readNonNegativeNumber(run?.promptCacheTokens);
  const promptEvalTokens = readNonNegativeNumber(run?.promptEvalTokens);
  const speculativeAcceptedTokens = readOptionalNonNegativeNumber(speculativeLogMetrics?.speculativeAcceptedTokens);
  const speculativeGeneratedTokens = readOptionalNonNegativeNumber(speculativeLogMetrics?.speculativeGeneratedTokens);
  const outputTokens = readNonNegativeNumber(run?.outputTokens);
  const thinkingTokens = readNonNegativeNumber(run?.thinkingTokens);
  const promptEvalDurationMs = readNonNegativeNumber(run?.promptEvalDurationMs);
  const generationDurationMs = readNonNegativeNumber(run?.generationDurationMs);
  return {
    promptCacheTokens,
    promptEvalTokens,
    cacheHitRate: getPromptCacheHitRate(promptCacheTokens, promptEvalTokens),
    speculativeAcceptedTokens,
    speculativeGeneratedTokens,
    acceptanceRate: getAcceptanceRate(speculativeAcceptedTokens, speculativeGeneratedTokens),
    promptTokensPerSecond: getPromptTokensPerSecond(promptEvalTokens, promptEvalDurationMs),
    generationTokensPerSecond: getGenerationTokensPerSecond(outputTokens, thinkingTokens, generationDurationMs),
    outputTokens,
    thinkingTokens,
    generationDurationMs: generationDurationMs > 0 ? generationDurationMs : null,
  };
}

function getActiveManagedLlamaPreset(config: DashboardConfig): DashboardConfig['Server']['LlamaCpp']['Presets'][number] | null {
  const presets = Array.isArray(config.Server.LlamaCpp.Presets) ? config.Server.LlamaCpp.Presets : [];
  if (presets.length === 0) {
    return null;
  }
  const activePresetId = typeof config.Server.LlamaCpp.ActivePresetId === 'string'
    ? config.Server.LlamaCpp.ActivePresetId.trim()
    : '';
  return presets.find((entry) => entry.id === activePresetId) ?? presets[0] ?? null;
}

export function applySpeculativeCaseToConfig(config: DashboardConfig, entry: SpecBenchmarkCase): DashboardConfig {
  const cloned = JSON.parse(JSON.stringify(config)) as DashboardConfig;
  const activePreset = getActiveManagedLlamaPreset(cloned);
  cloned.Server.LlamaCpp.SpeculativeEnabled = entry.speculativeEnabled !== false;
  cloned.Server.LlamaCpp.SpeculativeType = 'ngram-mod';
  if (activePreset) {
    activePreset.SpeculativeEnabled = entry.speculativeEnabled !== false;
    activePreset.SpeculativeType = 'ngram-mod';
  }
  if (entry.speculativeEnabled === false) {
    return cloned;
  }
  cloned.Server.LlamaCpp.SpeculativeNgramSizeN = entry.speculativeNgramSizeN;
  cloned.Server.LlamaCpp.SpeculativeNgramSizeM = entry.speculativeNgramSizeM;
  cloned.Server.LlamaCpp.SpeculativeNgramMinHits = entry.speculativeNgramMinHits;
  cloned.Server.LlamaCpp.SpeculativeDraftMax = entry.speculativeDraftMax;
  cloned.Server.LlamaCpp.SpeculativeDraftMin = entry.speculativeDraftMin;
  if (activePreset) {
    activePreset.SpeculativeNgramSizeN = entry.speculativeNgramSizeN;
    activePreset.SpeculativeNgramSizeM = entry.speculativeNgramSizeM;
    activePreset.SpeculativeNgramMinHits = entry.speculativeNgramMinHits;
    activePreset.SpeculativeDraftMax = entry.speculativeDraftMax;
    activePreset.SpeculativeDraftMin = entry.speculativeDraftMin;
  }
  return cloned;
}

export function sortBenchmarkResults<T extends { runMetrics?: { generationTokensPerSecond?: number | null } }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => (
    Number(right.runMetrics?.generationTokensPerSecond || 0)
    - Number(left.runMetrics?.generationTokensPerSecond || 0)
  ));
}
