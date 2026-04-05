import * as fs from 'node:fs';
import { writeText } from './http-utils.js';

type Dict = Record<string, unknown>;

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

export function getDefaultMetrics(): Metrics {
  return {
    inputCharactersTotal: 0,
    outputCharactersTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    thinkingTokensTotal: 0,
    promptCacheTokensTotal: 0,
    promptEvalTokensTotal: 0,
    requestDurationMsTotal: 0,
    completedRequestCount: 0,
    updatedAtUtc: null,
  };
}

export function normalizeMetrics(input: unknown): Metrics {
  const metrics = getDefaultMetrics();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return metrics;
  }
  const record = input as Dict;
  if (Number.isFinite(record.inputCharactersTotal) && Number(record.inputCharactersTotal) >= 0) {
    metrics.inputCharactersTotal = Number(record.inputCharactersTotal);
  }
  if (Number.isFinite(record.outputCharactersTotal) && Number(record.outputCharactersTotal) >= 0) {
    metrics.outputCharactersTotal = Number(record.outputCharactersTotal);
  }
  if (Number.isFinite(record.inputTokensTotal) && Number(record.inputTokensTotal) >= 0) {
    metrics.inputTokensTotal = Number(record.inputTokensTotal);
  }
  if (Number.isFinite(record.outputTokensTotal) && Number(record.outputTokensTotal) >= 0) {
    metrics.outputTokensTotal = Number(record.outputTokensTotal);
  }
  if (Number.isFinite(record.thinkingTokensTotal) && Number(record.thinkingTokensTotal) >= 0) {
    metrics.thinkingTokensTotal = Number(record.thinkingTokensTotal);
  }
  if (Number.isFinite(record.promptCacheTokensTotal) && Number(record.promptCacheTokensTotal) >= 0) {
    metrics.promptCacheTokensTotal = Number(record.promptCacheTokensTotal);
  }
  if (Number.isFinite(record.promptEvalTokensTotal) && Number(record.promptEvalTokensTotal) >= 0) {
    metrics.promptEvalTokensTotal = Number(record.promptEvalTokensTotal);
  }
  if (Number.isFinite(record.requestDurationMsTotal) && Number(record.requestDurationMsTotal) >= 0) {
    metrics.requestDurationMsTotal = Number(record.requestDurationMsTotal);
  }
  if (Number.isFinite(record.completedRequestCount) && Number(record.completedRequestCount) >= 0) {
    metrics.completedRequestCount = Number(record.completedRequestCount);
  }
  if (typeof record.updatedAtUtc === 'string' && record.updatedAtUtc.trim()) {
    metrics.updatedAtUtc = record.updatedAtUtc;
  }
  return metrics;
}

export function readMetrics(metricsPath: string): Metrics {
  if (!fs.existsSync(metricsPath)) {
    return getDefaultMetrics();
  }
  try {
    return normalizeMetrics(JSON.parse(fs.readFileSync(metricsPath, 'utf8')));
  } catch {
    return getDefaultMetrics();
  }
}

export function writeMetrics(metricsPath: string, metrics: Metrics): void {
  writeText(metricsPath, `${JSON.stringify(normalizeMetrics(metrics), null, 2)}\n`);
}
