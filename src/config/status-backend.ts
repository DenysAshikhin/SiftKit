import { requestJson } from '../lib/http.js';
import { sleep } from '../lib/time.js';
import { getStatusServerConnectHost } from '../lib/status-host.js';
import { getInferenceStatusPath } from './paths.js';
import { StatusServerUnavailableError } from './errors.js';
import type { StatusSnapshotResponse } from './types.js';

const DEFAULT_HEALTHCHECK_ATTEMPTS = 5;
const DEFAULT_BUSY_HEALTHCHECK_ATTEMPTS = 60;
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 1000;
const DEFAULT_HEALTHCHECK_BACKOFF_MS = 100;
const DEFAULT_HEALTHCHECK_MAX_BACKOFF_MS = 1000;

function envHasValue(key: string): boolean {
  return typeof process.env[key] === 'string' && String(process.env[key]).trim().length > 0;
}

function readPositiveIntegerEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[key] || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[key] || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function shouldTraceHealthcheckAttempts(): boolean {
  return String(process.env.SIFTKIT_HEALTHCHECK_TRACE || '').trim() === '1';
}

function isTimedOutHealthcheck(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Request timed out after ');
}

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

  const host = getStatusServerConnectHost();
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

export function toStatusServerUnavailableError(options: {
  cause?: unknown;
  operation?: string;
  serviceUrl?: string;
} = {}): StatusServerUnavailableError {
  return new StatusServerUnavailableError(getStatusServerHealthUrl(), options);
}

export async function getStatusSnapshot(): Promise<StatusSnapshotResponse> {
  try {
    return await requestJson<StatusSnapshotResponse>({
      url: getStatusBackendUrl(),
      method: 'GET',
      timeoutMs: 2000,
    });
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: error,
      operation: 'status:get',
      serviceUrl: getStatusBackendUrl(),
    });
  }
}

export async function ensureStatusServerReachable(): Promise<void> {
  const healthUrl = getStatusServerHealthUrl();
  const attemptsConfigured = envHasValue('SIFTKIT_HEALTHCHECK_ATTEMPTS');
  const attempts = readPositiveIntegerEnv('SIFTKIT_HEALTHCHECK_ATTEMPTS', DEFAULT_HEALTHCHECK_ATTEMPTS);
  const busyAttempts = attemptsConfigured
    ? attempts
    : readPositiveIntegerEnv('SIFTKIT_HEALTHCHECK_BUSY_ATTEMPTS', DEFAULT_BUSY_HEALTHCHECK_ATTEMPTS);
  const maxAttempts = Math.max(attempts, busyAttempts);
  const timeoutMs = readPositiveIntegerEnv('SIFTKIT_HEALTHCHECK_TIMEOUT_MS', DEFAULT_HEALTHCHECK_TIMEOUT_MS);
  const baseBackoffMs = readNonNegativeIntegerEnv('SIFTKIT_HEALTHCHECK_BACKOFF_MS', DEFAULT_HEALTHCHECK_BACKOFF_MS);
  const maxBackoffMs = readNonNegativeIntegerEnv('SIFTKIT_HEALTHCHECK_MAX_BACKOFF_MS', DEFAULT_HEALTHCHECK_MAX_BACKOFF_MS);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await requestJson<{ ok?: boolean }>({
        url: healthUrl,
        method: 'GET',
        timeoutMs,
      });
      if (!response || response.ok !== true) {
        throw new Error('Health endpoint did not return ok=true.');
      }
      return;
    } catch (error) {
      lastError = error;
      const isTimeout = isTimedOutHealthcheck(error);
      const cause = error instanceof Error ? error.message : String(error);
      if (shouldTraceHealthcheckAttempts()) {
        process.stderr.write(
          `[siftkit] healthcheck attempt ${attempt}/${isTimeout ? busyAttempts : attempts} failed `
          + `url=${healthUrl} timeout_ms=${timeoutMs} cause=${cause}\n`
        );
      }
      if (attempt >= (isTimeout ? busyAttempts : attempts)) {
        break;
      }
      const exponentialDelayMs = baseBackoffMs * (2 ** (attempt - 1));
      const delayMs = maxBackoffMs > 0 ? Math.min(exponentialDelayMs, maxBackoffMs) : exponentialDelayMs;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw toStatusServerUnavailableError({
    cause: lastError,
    operation: 'health:get',
    serviceUrl: healthUrl,
  });
}

export type NotifyStatusBackendOptions = {
  running: boolean;
  statusBackendUrl?: string | null;
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
    lineReadCalls?: number;
    lineReadLinesTotal?: number;
    lineReadTokensTotal?: number;
    finishRejections?: number;
    semanticRepeatRejects?: number;
    stagnationWarnings?: number;
    forcedFinishFromStagnation?: number;
    promptInsertedTokens?: number;
    rawToolResultTokens?: number;
    newEvidenceCalls?: number;
    noNewEvidenceCalls?: number;
  }> | null;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  requestDurationMs?: number | null;
  providerDurationMs?: number | null;
  wallDurationMs?: number | null;
  stdinWaitMs?: number | null;
  serverPreflightMs?: number | null;
  lockWaitMs?: number | null;
  statusRunningMs?: number | null;
  terminalStatusMs?: number | null;
  artifactType?: 'summary_request' | 'planner_debug' | 'planner_failed' | null;
  artifactRequestId?: string | null;
  artifactPayload?: Record<string, unknown> | null;
  deferredMetadata?: Record<string, unknown> | null;
  deferredArtifacts?: Array<{
    artifactType: 'summary_request' | 'planner_debug' | 'planner_failed';
    artifactRequestId: string;
    artifactPayload: Record<string, unknown>;
  }> | null;
};

function buildStatusNotificationBody(options: NotifyStatusBackendOptions): Record<string, unknown> {
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
  if (!options.running && options.speculativeAcceptedTokens !== undefined && options.speculativeAcceptedTokens !== null) {
    body.speculativeAcceptedTokens = options.speculativeAcceptedTokens;
  }
  if (!options.running && options.speculativeGeneratedTokens !== undefined && options.speculativeGeneratedTokens !== null) {
    body.speculativeGeneratedTokens = options.speculativeGeneratedTokens;
  }
  if (!options.running && options.requestDurationMs !== undefined && options.requestDurationMs !== null) {
    body.requestDurationMs = options.requestDurationMs;
  }
  const timingFields = {
    providerDurationMs: options.providerDurationMs,
    wallDurationMs: options.wallDurationMs,
    stdinWaitMs: options.stdinWaitMs,
    serverPreflightMs: options.serverPreflightMs,
    lockWaitMs: options.lockWaitMs,
    statusRunningMs: options.statusRunningMs,
    terminalStatusMs: options.terminalStatusMs,
  };
  for (const [key, value] of Object.entries(timingFields)) {
    if (!options.running && value !== undefined && value !== null) {
      body[key] = value;
    }
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
  if (
    options.deferredMetadata
    && typeof options.deferredMetadata === 'object'
    && !Array.isArray(options.deferredMetadata)
  ) {
    body.deferredMetadata = options.deferredMetadata;
  }
  if (!options.running && options.terminalState && Array.isArray(options.deferredArtifacts) && options.deferredArtifacts.length > 0) {
    const deferredArtifacts = options.deferredArtifacts
      .filter((artifact) => (
        artifact
        && typeof artifact === 'object'
        && typeof artifact.artifactType === 'string'
        && typeof artifact.artifactRequestId === 'string'
        && artifact.artifactRequestId.trim()
        && artifact.artifactPayload
        && typeof artifact.artifactPayload === 'object'
        && !Array.isArray(artifact.artifactPayload)
      ))
      .map((artifact) => ({
        artifactType: artifact.artifactType,
        artifactRequestId: artifact.artifactRequestId.trim(),
        artifactPayload: artifact.artifactPayload,
      }));
    if (deferredArtifacts.length > 0) {
      body.deferredArtifacts = deferredArtifacts;
    }
  }

  return body;
}

async function postStatusJson(options: {
  url: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  operation: string;
}): Promise<void> {
  try {
    await requestJson<{ ok?: boolean; busy?: boolean }>({
      url: options.url,
      method: 'POST',
      timeoutMs: options.timeoutMs,
      body: JSON.stringify(options.body),
    });
  } catch (error) {
    throw toStatusServerUnavailableError({
      cause: error,
      operation: options.operation,
      serviceUrl: options.url,
    });
  }
}

export async function notifyStatusBackend(options: NotifyStatusBackendOptions): Promise<void> {
  const url = (options.statusBackendUrl && options.statusBackendUrl.trim()) ? options.statusBackendUrl.trim() : getStatusBackendUrl();
  const body = buildStatusNotificationBody(options);
  if (!options.running && options.terminalState) {
    const completionUrl = deriveServiceUrl(url, '/status/complete');
    const metadataUrl = deriveServiceUrl(url, '/status/terminal-metadata');
    try {
      await postStatusJson({
        url: completionUrl,
        body: {
          statusPath: body.statusPath,
          requestId: body.requestId,
          taskKind: body.taskKind,
          terminalState: body.terminalState,
          updatedAtUtc: body.updatedAtUtc,
        },
        timeoutMs: 10,
        operation: 'status:complete',
      });
    } catch {
      // Best-effort: the server may have processed /status/complete even if the client
      // timed out. Continue and still fire terminal-metadata so the metrics enqueue is sent.
    }
    void postStatusJson({
      url: metadataUrl,
      body,
      timeoutMs: 2000,
      operation: 'status:terminal-metadata',
    }).catch(() => undefined);
    return;
  }

  await postStatusJson({
    url,
    timeoutMs: 2000,
    body,
    operation: 'status:notify',
  });
}
