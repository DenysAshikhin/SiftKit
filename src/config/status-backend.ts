import { requestJson } from '../lib/http.js';
import { sleep } from '../lib/time.js';
import { getInferenceStatusPath } from './paths.js';
import { StatusServerUnavailableError } from './errors.js';
import type { StatusSnapshotResponse } from './types.js';

export function deriveServiceUrl(configuredUrl: string, nextPath: string): string {
  const target = new URL(configuredUrl);
  target.pathname = nextPath;
  target.search = '';
  target.hash = '';
  return target.toString();
}

export function getStatusBackendUrl(): string {
  const configuredUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  if (configuredUrl && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  const host = process.env.SIFTKIT_STATUS_HOST?.trim() || '127.0.0.1';
  const port = process.env.SIFTKIT_STATUS_PORT?.trim() || '4765';
  return `http://${host}:${port}/status`;
}

export function getStatusServerHealthUrl(): string {
  const configuredConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  if (configuredConfigUrl && configuredConfigUrl.trim()) {
    return deriveServiceUrl(configuredConfigUrl.trim(), '/health');
  }

  return deriveServiceUrl(getStatusBackendUrl(), '/health');
}

export function getStatusServerUnavailableMessage(): string {
  return new StatusServerUnavailableError(getStatusServerHealthUrl()).message;
}

export function toStatusServerUnavailableError(): StatusServerUnavailableError {
  return new StatusServerUnavailableError(getStatusServerHealthUrl());
}

export async function getStatusSnapshot(): Promise<StatusSnapshotResponse> {
  try {
    return await requestJson<StatusSnapshotResponse>({
      url: getStatusBackendUrl(),
      method: 'GET',
      timeoutMs: 2000,
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function ensureStatusServerReachable(): Promise<void> {
  try {
    const response = await requestJson<{ ok?: boolean }>({
      url: getStatusServerHealthUrl(),
      method: 'GET',
      timeoutMs: 2000,
    });
    if (!response || response.ok !== true) {
      throw new Error('Health endpoint did not return ok=true.');
    }
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export type NotifyStatusBackendOptions = {
  running: boolean;
  statusBackendUrl?: string | null;
  busyRetryMaxRetries?: number;
  busyRetryDelayMs?: number;
  taskKind?: 'summary' | 'plan' | 'repo-search' | 'chat' | null;
  requestId?: string | null;
  terminalState?: 'completed' | 'failed' | null;
  errorMessage?: string | null;
  promptCharacterCount?: number | null;
  promptTokenCount?: number | null;
  rawInputCharacterCount?: number | null;
  chunkInputCharacterCount?: number | null;
  budgetSource?: string | null;
  inputCharactersPerContextToken?: number | null;
  chunkThresholdCharacters?: number | null;
  phase?: 'leaf' | 'merge' | 'planner';
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  chunkPath?: string | null;
  inputTokens?: number | null;
  outputCharacterCount?: number | null;
  outputTokens?: number | null;
  toolTokens?: number | null;
  thinkingTokens?: number | null;
  toolStats?: Record<string, {
    calls?: number;
    outputCharsTotal?: number;
    outputTokensTotal?: number;
    outputTokensEstimatedCount?: number;
  }> | null;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  requestDurationMs?: number | null;
  artifactType?: 'summary_request' | 'planner_debug' | 'planner_failed' | null;
  artifactRequestId?: string | null;
  artifactPayload?: Record<string, unknown> | null;
};

export async function notifyStatusBackend(options: NotifyStatusBackendOptions): Promise<void> {
  const body: Record<string, unknown> = {
    running: options.running,
    status: options.running ? 'true' : 'false',
    statusPath: getInferenceStatusPath(),
    updatedAtUtc: new Date().toISOString(),
  };

  if (options.requestId && options.requestId.trim()) {
    body.requestId = options.requestId.trim();
  }
  if (options.taskKind === 'summary' || options.taskKind === 'plan' || options.taskKind === 'repo-search' || options.taskKind === 'chat') {
    body.taskKind = options.taskKind;
  }
  if (!options.running && options.terminalState) {
    body.terminalState = options.terminalState;
  }
  if (!options.running && options.errorMessage && options.errorMessage.trim()) {
    body.errorMessage = options.errorMessage.trim();
  }
  if (options.promptCharacterCount !== undefined && options.promptCharacterCount !== null) {
    body.promptCharacterCount = options.promptCharacterCount;
  }
  if (options.running && options.promptTokenCount !== undefined && options.promptTokenCount !== null) {
    body.promptTokenCount = options.promptTokenCount;
  }
  if (options.running && options.rawInputCharacterCount !== undefined && options.rawInputCharacterCount !== null) {
    body.rawInputCharacterCount = options.rawInputCharacterCount;
  }
  if (options.running && options.chunkInputCharacterCount !== undefined && options.chunkInputCharacterCount !== null) {
    body.chunkInputCharacterCount = options.chunkInputCharacterCount;
  }
  if (options.running && options.budgetSource && options.budgetSource.trim()) {
    body.budgetSource = options.budgetSource.trim();
  }
  if (options.running && options.inputCharactersPerContextToken !== undefined && options.inputCharactersPerContextToken !== null) {
    body.inputCharactersPerContextToken = options.inputCharactersPerContextToken;
  }
  if (options.running && options.chunkThresholdCharacters !== undefined && options.chunkThresholdCharacters !== null) {
    body.chunkThresholdCharacters = options.chunkThresholdCharacters;
  }
  if (options.running && options.phase) {
    body.phase = options.phase;
  }
  if (
    options.running
    && options.chunkIndex
    && options.chunkTotal
    && options.chunkIndex > 0
    && options.chunkTotal > 0
  ) {
    body.chunkIndex = options.chunkIndex;
    body.chunkTotal = options.chunkTotal;
  }
  if (options.running && options.chunkPath && options.chunkPath.trim()) {
    body.chunkPath = options.chunkPath.trim();
  }
  if (!options.running && options.inputTokens !== undefined && options.inputTokens !== null) {
    body.inputTokens = options.inputTokens;
  }
  if (!options.running && options.outputCharacterCount !== undefined && options.outputCharacterCount !== null) {
    body.outputCharacterCount = options.outputCharacterCount;
  }
  if (!options.running && options.outputTokens !== undefined && options.outputTokens !== null) {
    body.outputTokens = options.outputTokens;
  }
  if (!options.running && options.toolTokens !== undefined && options.toolTokens !== null) {
    body.toolTokens = options.toolTokens;
  }
  if (!options.running && options.thinkingTokens !== undefined && options.thinkingTokens !== null) {
    body.thinkingTokens = options.thinkingTokens;
  }
  if (!options.running && options.toolStats && typeof options.toolStats === 'object' && !Array.isArray(options.toolStats)) {
    body.toolStats = options.toolStats;
  }
  if (!options.running && options.promptCacheTokens !== undefined && options.promptCacheTokens !== null) {
    body.promptCacheTokens = options.promptCacheTokens;
  }
  if (!options.running && options.promptEvalTokens !== undefined && options.promptEvalTokens !== null) {
    body.promptEvalTokens = options.promptEvalTokens;
  }
  if (!options.running && options.requestDurationMs !== undefined && options.requestDurationMs !== null) {
    body.requestDurationMs = options.requestDurationMs;
  }
  if (!options.running && options.artifactType) {
    body.artifactType = options.artifactType;
  }
  if (!options.running && options.artifactRequestId && options.artifactRequestId.trim()) {
    body.artifactRequestId = options.artifactRequestId.trim();
  }
  if (
    !options.running
    && options.artifactPayload
    && typeof options.artifactPayload === 'object'
    && !Array.isArray(options.artifactPayload)
  ) {
    body.artifactPayload = options.artifactPayload;
  }

  const url = (options.statusBackendUrl && options.statusBackendUrl.trim()) ? options.statusBackendUrl.trim() : getStatusBackendUrl();
  const configuredBusyRetryMaxRetries = Number(options.busyRetryMaxRetries);
  const maxRetries = Number.isFinite(configuredBusyRetryMaxRetries) && configuredBusyRetryMaxRetries >= 0
    ? Math.floor(configuredBusyRetryMaxRetries)
    : (options.running ? 600 : 0);
  const configuredBusyRetryDelayMs = Number(options.busyRetryDelayMs);
  const busyRetryDelayMs = Number.isFinite(configuredBusyRetryDelayMs) && configuredBusyRetryDelayMs > 0
    ? Math.floor(configuredBusyRetryDelayMs)
    : 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await requestJson<{ ok?: boolean; busy?: boolean }>({
        url,
        method: 'POST',
        timeoutMs: 2000,
        body: JSON.stringify(body),
      });
      if (response && response.busy) {
        if (attempt < maxRetries) {
          await sleep(busyRetryDelayMs);
          continue;
        }
        throw new Error(
          `Status backend remained busy after ${maxRetries + 1} attempts `
          + `(delay_ms=${busyRetryDelayMs}).`,
        );
      }
      return;
    } catch (error) {
      if (error instanceof Error && /Status backend remained busy/iu.test(error.message)) {
        throw error;
      }
      throw toStatusServerUnavailableError();
    }
  }
}
