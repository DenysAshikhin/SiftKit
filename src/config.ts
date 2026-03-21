import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

export const SIFTKIT_VERSION = '0.1.0';
export const SIFT_DEFAULT_NUM_CTX = 128_000;
export const SIFT_LEGACY_DEFAULT_NUM_CTX = 16_384;
export const SIFT_LEGACY_DERIVED_NUM_CTX = 32_000;
export const SIFT_PREVIOUS_DEFAULT_NUM_CTX = 50_000;
export const SIFT_PREVIOUS_DEFAULT_MODEL = 'qwen3.5-4b-q8_0';
export const SIFT_DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const SIFT_DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
export const SIFT_DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-35B-4bit-150k-no-thinking.ps1';
export const SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\stop-llama-server.ps1';
export const SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = 32_000;
export const SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = 2.5;
export const SIFT_DEFAULT_PROMPT_PREFIX = 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.';

export type RuntimeLlamaCppConfig = {
  BaseUrl?: string | null;
  NumCtx?: number | null;
  ModelPath?: string | null;
  Temperature?: number | null;
  TopP?: number | null;
  TopK?: number | null;
  MinP?: number | null;
  PresencePenalty?: number | null;
  RepetitionPenalty?: number | null;
  MaxTokens?: number | null;
  GpuLayers?: number | null;
  Threads?: number | null;
  FlashAttention?: boolean | null;
  ParallelSlots?: number | null;
  Reasoning?: 'on' | 'off' | 'auto' | null;
};

export type ServerManagedLlamaCppConfig = {
  StartupScript?: string | null;
  ShutdownScript?: string | null;
  StartupTimeoutMs?: number | null;
  HealthcheckTimeoutMs?: number | null;
  HealthcheckIntervalMs?: number | null;
};

export type SiftConfig = {
  Version: string;
  Backend: string;
  Model?: string | null;
  PolicyMode: string;
  RawLogRetention: boolean;
  PromptPrefix?: string | null;
  LlamaCpp: RuntimeLlamaCppConfig;
  Runtime?: {
    Model?: string | null;
    LlamaCpp?: RuntimeLlamaCppConfig;
  };
  Thresholds: {
    MinCharactersForSummary: number;
    MinLinesForSummary: number;
    ChunkThresholdRatio: number;
    MaxInputCharacters?: number;
  };
  Interactive: {
    Enabled: boolean;
    WrappedCommands: string[];
    IdleTimeoutMs: number;
    MaxTranscriptCharacters: number;
    TranscriptRetention: boolean;
  };
  Server?: {
    LlamaCpp?: ServerManagedLlamaCppConfig;
  };
  Paths?: {
    RuntimeRoot: string;
    Logs: string;
    EvalFixtures: string;
    EvalResults: string;
  };
  Effective?: {
    ConfigAuthoritative: boolean;
    RuntimeConfigReady: boolean;
    MissingRuntimeFields: string[];
    BudgetSource: string;
    NumCtx: number | null;
    InputCharactersPerContextToken: number;
    ObservedTelemetrySeen: boolean;
    ObservedTelemetryUpdatedAtUtc: string | null;
    MaxInputCharacters: number | null;
    ChunkThresholdRatio: number;
    ChunkThresholdCharacters: number | null;
    LegacyMaxInputCharactersRemoved: boolean;
    LegacyMaxInputCharactersValue: number | null;
  };
};

type NormalizationInfo = {
  changed: boolean;
  legacyMaxInputCharactersRemoved: boolean;
  legacyMaxInputCharactersValue: number | null;
};

type StatusMetricsSnapshot = {
  inputCharactersTotal?: number;
  inputTokensTotal?: number;
};

type StatusSnapshotResponse = {
  metrics?: StatusMetricsSnapshot;
};

type ObservedBudgetState = {
  observedTelemetrySeen: boolean;
  lastKnownCharsPerToken: number | null;
  updatedAtUtc: string | null;
};

const RUNTIME_OWNED_LLAMA_CPP_KEYS = [
  'BaseUrl',
  'NumCtx',
  'ModelPath',
  'Temperature',
  'TopP',
  'TopK',
  'MinP',
  'PresencePenalty',
  'RepetitionPenalty',
  'MaxTokens',
  'GpuLayers',
  'Threads',
  'FlashAttention',
  'ParallelSlots',
  'Reasoning',
] as const;

type RuntimeOwnedLlamaCppKey = typeof RUNTIME_OWNED_LLAMA_CPP_KEYS[number];

function parseJsonText<T>(text: string): T {
  const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return JSON.parse(normalized) as T;
}

function requestJson<T>(options: {
  url: string;
  method: 'GET' | 'PUT' | 'POST';
  timeoutMs: number;
  body?: string;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
            return;
          }

          if (!responseText.trim()) {
            resolve({} as T);
            return;
          }

          try {
            resolve(parseJsonText<T>(responseText));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    });
    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

export class StatusServerUnavailableError extends Error {
  healthUrl: string;

  constructor(healthUrl: string) {
    super(`SiftKit status/config server is not reachable at ${healthUrl}. Start the separate server process and stop issuing further siftkit commands until it is available.`);
    this.name = 'StatusServerUnavailableError';
    this.healthUrl = healthUrl;
  }
}

export class MissingObservedBudgetError extends Error {
  constructor(message = 'SiftKit status server did not provide usable input character/token totals. Refusing to derive chunk budgets from the hardcoded fallback; run at least one successful request or fix status metrics first.') {
    super(message);
    this.name = 'MissingObservedBudgetError';
  }
}

function deriveServiceUrl(configuredUrl: string, nextPath: string): string {
  const target = new URL(configuredUrl);
  target.pathname = nextPath;
  target.search = '';
  target.hash = '';
  return target.toString();
}

export function ensureDirectory(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function writeUtf8NoBom(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8' });
}

function isRetryableFsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? String(error.code ?? '') : '';
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export function saveContentAtomically(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  ensureDirectory(directory);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = path.join(
      directory,
      `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`
    );

    try {
      writeUtf8NoBom(tempPath, content);
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Ignore temp cleanup failures during retry handling.
      }

      if (!isRetryableFsError(error) || attempt === 4) {
        break;
      }
    }
  }

  if (isRetryableFsError(lastError)) {
    writeUtf8NoBom(filePath, content);
    return;
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to save ${filePath} atomically.`);
}

function isRuntimeRootWritable(candidate: string | null | undefined): boolean {
  if (!candidate || !candidate.trim()) {
    return false;
  }

  try {
    const fullPath = path.resolve(candidate);
    ensureDirectory(fullPath);
    const probePath = path.join(fullPath, `${Math.random().toString(16).slice(2)}.tmp`);
    writeUtf8NoBom(probePath, 'probe');
    fs.rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function getRuntimeRoot(): string {
  const configuredStatusPath = process.env.sift_kit_status;
  if (configuredStatusPath && configuredStatusPath.trim()) {
    const absoluteStatusPath = path.resolve(configuredStatusPath);
    const statusDirectory = path.dirname(absoluteStatusPath);
    if (path.basename(statusDirectory).toLowerCase() === 'status') {
      return path.resolve(path.dirname(statusDirectory));
    }

    return path.resolve(statusDirectory);
  }

  const candidates: string[] = [];
  if (process.env.USERPROFILE?.trim()) {
    candidates.push(path.resolve(process.env.USERPROFILE, '.siftkit'));
  }
  if (process.cwd()) {
    candidates.push(path.resolve(process.cwd(), '.codex', 'siftkit'));
  }

  for (const candidate of candidates) {
    if (isRuntimeRootWritable(candidate)) {
      return candidate;
    }
  }

  if (candidates.length > 0) {
    return candidates[0];
  }

  return path.resolve(os.tmpdir(), 'siftkit');
}

export function initializeRuntime(): NonNullable<SiftConfig['Paths']> {
  const runtimeRoot = ensureDirectory(getRuntimeRoot());
  const logs = ensureDirectory(path.join(runtimeRoot, 'logs'));
  const evalRoot = ensureDirectory(path.join(runtimeRoot, 'eval'));
  const evalFixtures = ensureDirectory(path.join(evalRoot, 'fixtures'));
  const evalResults = ensureDirectory(path.join(evalRoot, 'results'));

  return {
    RuntimeRoot: runtimeRoot,
    Logs: logs,
    EvalFixtures: evalFixtures,
    EvalResults: evalResults,
  };
}

export function getDefaultNumCtx(): number {
  return SIFT_DEFAULT_NUM_CTX;
}

function getCompatRuntimeLlamaCpp(config: SiftConfig): RuntimeLlamaCppConfig {
  return config.Runtime?.LlamaCpp ?? config.LlamaCpp ?? {};
}

function getFinitePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getConfiguredModel(config: SiftConfig): string {
  const model = config.Runtime?.Model ?? config.Model;
  if (typeof model === 'string' && model.trim()) {
    return model.trim();
  }

  throw new Error('SiftKit runtime config is missing Model. Start a launcher script first.');
}

export function getConfiguredPromptPrefix(config: SiftConfig): string | undefined {
  const promptPrefix = config.PromptPrefix;
  return typeof promptPrefix === 'string' && promptPrefix.trim() ? promptPrefix : undefined;
}

export function getConfiguredLlamaBaseUrl(config: SiftConfig): string {
  const baseUrl = getCompatRuntimeLlamaCpp(config).BaseUrl;
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    return baseUrl.trim();
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.BaseUrl. Start a launcher script first.');
}

export function getConfiguredLlamaNumCtx(config: SiftConfig): number {
  const numCtx = getFinitePositiveNumber(getCompatRuntimeLlamaCpp(config).NumCtx);
  if (numCtx !== null) {
    return numCtx;
  }

  throw new Error('SiftKit runtime config is missing LlamaCpp.NumCtx. Start a launcher script first.');
}

export function getConfiguredLlamaSetting<T>(
  config: SiftConfig,
  key: RuntimeOwnedLlamaCppKey
): T | undefined {
  const runtimeValue = getCompatRuntimeLlamaCpp(config)[key];
  return (runtimeValue === undefined || runtimeValue === null) ? undefined : runtimeValue as T;
}

function getMissingRuntimeFields(config: SiftConfig): string[] {
  const missing: string[] = [];
  try {
    getConfiguredModel(config);
  } catch {
    missing.push('Model');
  }

  try {
    getConfiguredLlamaBaseUrl(config);
  } catch {
    missing.push('LlamaCpp.BaseUrl');
  }

  try {
    getConfiguredLlamaNumCtx(config);
  } catch {
    missing.push('LlamaCpp.NumCtx');
  }

  return missing;
}

export function getDerivedMaxInputCharacters(numCtx: number, inputCharactersPerContextToken = SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN): number {
  const effectiveNumCtx = numCtx > 0 ? numCtx : getDefaultNumCtx();
  const effectiveCharactersPerContextToken = inputCharactersPerContextToken > 0
    ? inputCharactersPerContextToken
    : SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
  return Math.max(Math.floor(effectiveNumCtx * effectiveCharactersPerContextToken), 1);
}

export function getEffectiveInputCharactersPerContextToken(config: SiftConfig): number {
  const effectiveValue = Number(config.Effective?.InputCharactersPerContextToken);
  return effectiveValue > 0 ? effectiveValue : SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
}

export function getEffectiveMaxInputCharacters(config: SiftConfig): number {
  return getDerivedMaxInputCharacters(
    getConfiguredLlamaNumCtx(config),
    getEffectiveInputCharactersPerContextToken(config)
  );
}

export function getChunkThresholdCharacters(config: SiftConfig): number {
  const ratio = Number(config.Thresholds.ChunkThresholdRatio);
  const effectiveRatio = ratio > 0 && ratio <= 1 ? ratio : 0.92;
  return Math.max(Math.floor(getEffectiveMaxInputCharacters(config) * effectiveRatio), 1);
}

export function getInferenceStatusPath(): string {
  const configuredPath = process.env.sift_kit_status;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.resolve(getRuntimeRoot(), 'status', 'inference.txt');
}

function getObservedBudgetStatePath(): string {
  return path.resolve(getRuntimeRoot(), 'metrics', 'observed-budget.json');
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

async function getStatusSnapshot(): Promise<StatusSnapshotResponse> {
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

function getDefaultObservedBudgetState(): ObservedBudgetState {
  return {
    observedTelemetrySeen: false,
    lastKnownCharsPerToken: null,
    updatedAtUtc: null,
  };
}

function normalizeObservedBudgetState(input: unknown): ObservedBudgetState {
  const fallback = getDefaultObservedBudgetState();
  if (!input || typeof input !== 'object') {
    return fallback;
  }

  const parsed = input as Record<string, unknown>;
  const lastKnownCharsPerToken = Number(parsed.lastKnownCharsPerToken);
  return {
    observedTelemetrySeen: parsed.observedTelemetrySeen === true && Number.isFinite(lastKnownCharsPerToken) && lastKnownCharsPerToken > 0,
    lastKnownCharsPerToken: Number.isFinite(lastKnownCharsPerToken) && lastKnownCharsPerToken > 0 ? lastKnownCharsPerToken : null,
    updatedAtUtc: typeof parsed.updatedAtUtc === 'string' && parsed.updatedAtUtc.trim() ? parsed.updatedAtUtc : null,
  };
}

function readObservedBudgetState(): ObservedBudgetState {
  const statePath = getObservedBudgetStatePath();
  if (!fs.existsSync(statePath)) {
    return getDefaultObservedBudgetState();
  }

  try {
    return normalizeObservedBudgetState(parseJsonText<ObservedBudgetState>(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return getDefaultObservedBudgetState();
  }
}

function writeObservedBudgetState(state: ObservedBudgetState): void {
  saveContentAtomically(
    getObservedBudgetStatePath(),
    `${JSON.stringify(normalizeObservedBudgetState(state), null, 2)}\n`
  );
}

function tryWriteObservedBudgetState(state: ObservedBudgetState): void {
  try {
    writeObservedBudgetState(state);
  } catch {
    // Observed-budget persistence is advisory. Request execution should continue.
  }
}

function getObservedInputCharactersPerContextToken(snapshot: StatusSnapshotResponse | null | undefined): number | null {
  const inputCharactersTotal = Number(snapshot?.metrics?.inputCharactersTotal);
  const inputTokensTotal = Number(snapshot?.metrics?.inputTokensTotal);
  if (!Number.isFinite(inputCharactersTotal) || inputCharactersTotal <= 0) {
    return null;
  }
  if (!Number.isFinite(inputTokensTotal) || inputTokensTotal <= 0) {
    return null;
  }

  return inputCharactersTotal / inputTokensTotal;
}

async function resolveInputCharactersPerContextToken(): Promise<{ value: number; budgetSource: string }> {
  const persistedState = readObservedBudgetState();
  let snapshot: StatusSnapshotResponse;
  try {
    snapshot = await getStatusSnapshot();
  } catch {
    if (persistedState.observedTelemetrySeen) {
      throw new MissingObservedBudgetError(
        'SiftKit previously recorded a valid observed chars-per-token budget, but the status server is unavailable or no longer exposes usable totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.'
      );
    }
    return {
      value: SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
      budgetSource: 'ColdStartFixedCharsPerToken',
    };
  }

  const observedValue = getObservedInputCharactersPerContextToken(snapshot);
  if (observedValue !== null) {
    tryWriteObservedBudgetState({
      observedTelemetrySeen: true,
      lastKnownCharsPerToken: observedValue,
      updatedAtUtc: new Date().toISOString(),
    });
    return {
      value: observedValue,
      budgetSource: 'ObservedCharsPerToken',
    };
  }

  if (persistedState.observedTelemetrySeen) {
    throw new MissingObservedBudgetError(
      'SiftKit previously recorded a valid observed chars-per-token budget, but the status server no longer provides usable input character/token totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.'
    );
  }

  return {
    value: SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
    budgetSource: 'ColdStartFixedCharsPerToken',
  };
}

export function getExecutionServiceUrl(): string {
  return deriveServiceUrl(getStatusBackendUrl(), '/execution');
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

function toStatusServerUnavailableError(): StatusServerUnavailableError {
  return new StatusServerUnavailableError(getStatusServerHealthUrl());
}

export async function getExecutionServerState(): Promise<{ busy: boolean }> {
  try {
    const response = await requestJson<{ busy?: boolean }>({
      url: getExecutionServiceUrl(),
      method: 'GET',
      timeoutMs: 2000,
    });
    if (typeof response?.busy !== 'boolean') {
      throw new Error('Execution endpoint did not return a usable busy flag.');
    }

    return {
      busy: response.busy,
    };
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function tryAcquireExecutionLease(): Promise<{ acquired: boolean; token: string | null }> {
  try {
    const response = await requestJson<{ acquired?: boolean; token?: string | null }>({
      url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/acquire`,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ pid: process.pid }),
    });
    if (typeof response?.acquired !== 'boolean') {
      throw new Error('Execution acquire endpoint did not return a usable acquired flag.');
    }

    return {
      acquired: response.acquired,
      token: response.acquired && typeof response.token === 'string' && response.token.trim() ? response.token : null,
    };
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function refreshExecutionLease(token: string): Promise<void> {
  try {
    await requestJson({
      url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/heartbeat`,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function releaseExecutionLease(token: string): Promise<void> {
  try {
    await requestJson({
      url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/release`,
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify({ token }),
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

export async function notifyStatusBackend(options: {
  running: boolean;
  promptCharacterCount?: number | null;
  rawInputCharacterCount?: number | null;
  chunkInputCharacterCount?: number | null;
  budgetSource?: string | null;
  inputCharactersPerContextToken?: number | null;
  chunkThresholdCharacters?: number | null;
  phase?: 'leaf' | 'merge';
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  inputTokens?: number | null;
  outputCharacterCount?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  requestDurationMs?: number | null;
}): Promise<void> {
  const body: Record<string, unknown> = {
    running: options.running,
    status: options.running ? 'true' : 'false',
    statusPath: getInferenceStatusPath(),
    updatedAtUtc: new Date().toISOString(),
  };

  if (options.promptCharacterCount !== undefined && options.promptCharacterCount !== null) {
    body.promptCharacterCount = options.promptCharacterCount;
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
  if (!options.running && options.inputTokens !== undefined && options.inputTokens !== null) {
    body.inputTokens = options.inputTokens;
  }
  if (!options.running && options.outputCharacterCount !== undefined && options.outputCharacterCount !== null) {
    body.outputCharacterCount = options.outputCharacterCount;
  }
  if (!options.running && options.outputTokens !== undefined && options.outputTokens !== null) {
    body.outputTokens = options.outputTokens;
  }
  if (!options.running && options.thinkingTokens !== undefined && options.thinkingTokens !== null) {
    body.thinkingTokens = options.thinkingTokens;
  }
  if (!options.running && options.requestDurationMs !== undefined && options.requestDurationMs !== null) {
    body.requestDurationMs = options.requestDurationMs;
  }

  try {
    await requestJson({
      url: getStatusBackendUrl(),
      method: 'POST',
      timeoutMs: 2000,
      body: JSON.stringify(body),
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export function getConfigServiceUrl(): string {
  const configuredUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  if (configuredUrl && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  return deriveServiceUrl(getStatusBackendUrl(), '/config');
}

export function getConfigPath(): string {
  return path.join(getRuntimeRoot(), 'config.json');
}

function getDefaultConfigObject(): SiftConfig {
  const runtimePaths = initializeRuntime();
  return {
    Version: SIFTKIT_VERSION,
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    PromptPrefix: SIFT_DEFAULT_PROMPT_PREFIX,
    LlamaCpp: {
      BaseUrl: SIFT_DEFAULT_LLAMA_BASE_URL,
      NumCtx: 150_000,
      ModelPath: SIFT_DEFAULT_LLAMA_MODEL_PATH,
      Temperature: 0.7,
      TopP: 0.8,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 1.5,
      RepetitionPenalty: 1.0,
      MaxTokens: 15_000,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Runtime: {
      Model: SIFT_DEFAULT_LLAMA_MODEL,
      LlamaCpp: {
        BaseUrl: SIFT_DEFAULT_LLAMA_BASE_URL,
        NumCtx: 150_000,
        ModelPath: SIFT_DEFAULT_LLAMA_MODEL_PATH,
        Temperature: 0.7,
        TopP: 0.8,
        TopK: 20,
        MinP: 0.0,
        PresencePenalty: 1.5,
        RepetitionPenalty: 1.0,
        MaxTokens: 15_000,
        FlashAttention: true,
        ParallelSlots: 1,
        Reasoning: 'off',
      },
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
      ChunkThresholdRatio: 0.92,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
      IdleTimeoutMs: 900_000,
      MaxTranscriptCharacters: 60_000,
      TranscriptRetention: true,
    },
    Server: {
      LlamaCpp: {
        StartupScript: SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
        ShutdownScript: SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
        StartupTimeoutMs: 120_000,
        HealthcheckTimeoutMs: 2_000,
        HealthcheckIntervalMs: 1_000,
      },
    },
    Paths: runtimePaths,
  };
}

function toPersistedConfigObject(config: SiftConfig): Omit<SiftConfig, 'Paths' | 'Effective'> {
  return {
    Version: config.Version,
    Backend: config.Backend,
    PolicyMode: config.PolicyMode,
    RawLogRetention: Boolean(config.RawLogRetention),
    PromptPrefix: config.PromptPrefix ?? SIFT_DEFAULT_PROMPT_PREFIX,
    LlamaCpp: {},
    Runtime: {
      ...(config.Runtime?.Model === undefined ? {} : { Model: config.Runtime?.Model ?? null }),
      LlamaCpp: {
        ...(config.Runtime?.LlamaCpp?.BaseUrl === undefined ? {} : { BaseUrl: config.Runtime?.LlamaCpp?.BaseUrl ?? null }),
        ...(config.Runtime?.LlamaCpp?.NumCtx === undefined ? {} : { NumCtx: config.Runtime?.LlamaCpp?.NumCtx ?? null }),
        ...(config.Runtime?.LlamaCpp?.ModelPath === undefined ? {} : { ModelPath: config.Runtime?.LlamaCpp?.ModelPath ?? null }),
        ...(config.Runtime?.LlamaCpp?.Temperature === undefined ? {} : { Temperature: config.Runtime?.LlamaCpp?.Temperature ?? null }),
        ...(config.Runtime?.LlamaCpp?.TopP === undefined ? {} : { TopP: config.Runtime?.LlamaCpp?.TopP ?? null }),
        ...(config.Runtime?.LlamaCpp?.TopK === undefined ? {} : { TopK: config.Runtime?.LlamaCpp?.TopK ?? null }),
        ...(config.Runtime?.LlamaCpp?.MinP === undefined ? {} : { MinP: config.Runtime?.LlamaCpp?.MinP ?? null }),
        ...(config.Runtime?.LlamaCpp?.PresencePenalty === undefined ? {} : { PresencePenalty: config.Runtime?.LlamaCpp?.PresencePenalty ?? null }),
        ...(config.Runtime?.LlamaCpp?.RepetitionPenalty === undefined ? {} : { RepetitionPenalty: config.Runtime?.LlamaCpp?.RepetitionPenalty ?? null }),
        ...(config.Runtime?.LlamaCpp?.MaxTokens === undefined ? {} : { MaxTokens: config.Runtime?.LlamaCpp?.MaxTokens ?? null }),
      },
    },
    Thresholds: {
      MinCharactersForSummary: Number(config.Thresholds.MinCharactersForSummary),
      MinLinesForSummary: Number(config.Thresholds.MinLinesForSummary),
      ChunkThresholdRatio: Number(config.Thresholds.ChunkThresholdRatio),
    },
    Interactive: {
      Enabled: Boolean(config.Interactive.Enabled),
      WrappedCommands: [...config.Interactive.WrappedCommands],
      IdleTimeoutMs: Number(config.Interactive.IdleTimeoutMs),
      MaxTranscriptCharacters: Number(config.Interactive.MaxTranscriptCharacters),
      TranscriptRetention: Boolean(config.Interactive.TranscriptRetention),
    },
    Server: {
      LlamaCpp: {
        StartupScript: config.Server?.LlamaCpp?.StartupScript ?? null,
        ShutdownScript: config.Server?.LlamaCpp?.ShutdownScript ?? null,
        StartupTimeoutMs: config.Server?.LlamaCpp?.StartupTimeoutMs ?? null,
        HealthcheckTimeoutMs: config.Server?.LlamaCpp?.HealthcheckTimeoutMs ?? null,
        HealthcheckIntervalMs: config.Server?.LlamaCpp?.HealthcheckIntervalMs ?? null,
      },
    },
  };
}

function updateRuntimePaths(config: SiftConfig): SiftConfig {
  return {
    ...config,
    Paths: initializeRuntime(),
  };
}

function applyRuntimeCompatibilityView(config: SiftConfig): SiftConfig {
  const runtime = config.Runtime ?? {};
  const runtimeLlamaCpp = runtime.LlamaCpp ?? {};
  const compatLlamaCpp: RuntimeLlamaCppConfig = {
    ...config.LlamaCpp,
    ...runtimeLlamaCpp,
  };

  return {
    ...config,
    Model: runtime.Model ?? config.Model ?? null,
    PromptPrefix: config.PromptPrefix ?? SIFT_DEFAULT_PROMPT_PREFIX,
    LlamaCpp: compatLlamaCpp,
  };
}

function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  const updated = JSON.parse(JSON.stringify(config)) as SiftConfig;
  const defaults = getDefaultConfigObject();
  let changed = false;
  let legacyMaxInputCharactersValue: number | null = null;
  let legacyMaxInputCharactersRemoved = false;

  updated.LlamaCpp ??= {};
  updated.Runtime ??= {
    Model: null,
    LlamaCpp: {},
  };
  updated.Runtime.LlamaCpp ??= {};
  updated.Thresholds ??= { ...defaults.Thresholds };
  updated.Interactive ??= { ...defaults.Interactive };
  updated.Server ??= {
    LlamaCpp: { ...defaults.Server?.LlamaCpp },
  };
  updated.Server.LlamaCpp ??= { ...defaults.Server?.LlamaCpp };

  const legacyOllama = (updated as SiftConfig & { Ollama?: Record<string, unknown> }).Ollama;
  if (legacyOllama) {
    updated.Runtime.LlamaCpp = {
      ...updated.Runtime.LlamaCpp,
      ...(legacyOllama.BaseUrl === undefined ? {} : { BaseUrl: String(legacyOllama.BaseUrl || '') || null }),
      ...(legacyOllama.NumCtx === undefined ? {} : { NumCtx: Number(legacyOllama.NumCtx || 0) || null }),
      ...(legacyOllama.ModelPath === undefined ? {} : { ModelPath: String(legacyOllama.ModelPath || '') || null }),
      ...(legacyOllama.Temperature === undefined ? {} : { Temperature: Number(legacyOllama.Temperature) }),
      ...(legacyOllama.TopP === undefined ? {} : { TopP: Number(legacyOllama.TopP) }),
      ...(legacyOllama.TopK === undefined ? {} : { TopK: Number(legacyOllama.TopK) }),
      ...(legacyOllama.MinP === undefined ? {} : { MinP: Number(legacyOllama.MinP) }),
      ...(legacyOllama.PresencePenalty === undefined ? {} : { PresencePenalty: Number(legacyOllama.PresencePenalty) }),
      ...(legacyOllama.RepetitionPenalty === undefined ? {} : { RepetitionPenalty: Number(legacyOllama.RepetitionPenalty) }),
      ...(legacyOllama.NumPredict === undefined ? {} : { MaxTokens: legacyOllama.NumPredict as number | null }),
    };
    changed = true;
  }
  delete (updated as SiftConfig & { Ollama?: Record<string, unknown> }).Ollama;

  if (updated.Backend === 'ollama') {
    updated.Backend = defaults.Backend;
    changed = true;
  }

  if (typeof updated.Model === 'string' && updated.Model.trim() && !updated.Runtime.Model) {
    updated.Runtime.Model = updated.Model;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(updated, 'Model')) {
    delete (updated as Partial<SiftConfig>).Model;
    changed = true;
  }
  const legacyRuntimePromptPrefix = (updated.Runtime as { PromptPrefix?: string | null } | undefined)?.PromptPrefix;
  if ((!updated.PromptPrefix || !String(updated.PromptPrefix).trim()) && typeof legacyRuntimePromptPrefix === 'string' && legacyRuntimePromptPrefix.trim()) {
    updated.PromptPrefix = legacyRuntimePromptPrefix;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(updated.Runtime ?? {}, 'PromptPrefix')) {
    delete (updated.Runtime as { PromptPrefix?: string | null }).PromptPrefix;
    changed = true;
  }
  if (!updated.PromptPrefix || !String(updated.PromptPrefix).trim()) {
    updated.PromptPrefix = defaults.PromptPrefix;
    changed = true;
  }

  for (const key of RUNTIME_OWNED_LLAMA_CPP_KEYS) {
    const value = updated.LlamaCpp[key];
    if (value !== undefined) {
      const runtimeLlamaCpp = updated.Runtime.LlamaCpp as Record<string, unknown>;
      if (runtimeLlamaCpp[key] === undefined) {
        runtimeLlamaCpp[key] = value;
      }
      delete updated.LlamaCpp[key];
      changed = true;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Thresholds, 'MinCharactersForSummary')) {
    updated.Thresholds.MinCharactersForSummary = defaults.Thresholds.MinCharactersForSummary;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Thresholds, 'MinLinesForSummary')) {
    updated.Thresholds.MinLinesForSummary = defaults.Thresholds.MinLinesForSummary;
    changed = true;
  }
  const hadExplicitMaxInputCharacters = Object.prototype.hasOwnProperty.call(updated.Thresholds, 'MaxInputCharacters');
  if (hadExplicitMaxInputCharacters) {
    legacyMaxInputCharactersValue = Number(updated.Thresholds.MaxInputCharacters ?? 0);
    delete updated.Thresholds.MaxInputCharacters;
    changed = true;
    if (legacyMaxInputCharactersValue > 0) {
      legacyMaxInputCharactersRemoved = true;
    } else {
      legacyMaxInputCharactersValue = null;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Thresholds, 'ChunkThresholdRatio')) {
    updated.Thresholds.ChunkThresholdRatio = defaults.Thresholds.ChunkThresholdRatio;
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'Enabled')) {
    updated.Interactive.Enabled = defaults.Interactive.Enabled;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'WrappedCommands')) {
    updated.Interactive.WrappedCommands = [...defaults.Interactive.WrappedCommands];
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'IdleTimeoutMs')) {
    updated.Interactive.IdleTimeoutMs = defaults.Interactive.IdleTimeoutMs;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'MaxTranscriptCharacters')) {
    updated.Interactive.MaxTranscriptCharacters = defaults.Interactive.MaxTranscriptCharacters;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Interactive, 'TranscriptRetention')) {
    updated.Interactive.TranscriptRetention = defaults.Interactive.TranscriptRetention;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'StartupScript')) {
    updated.Server.LlamaCpp.StartupScript = defaults.Server?.LlamaCpp?.StartupScript ?? null;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'ShutdownScript')) {
    updated.Server.LlamaCpp.ShutdownScript = defaults.Server?.LlamaCpp?.ShutdownScript ?? null;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'StartupTimeoutMs')) {
    updated.Server.LlamaCpp.StartupTimeoutMs = defaults.Server?.LlamaCpp?.StartupTimeoutMs ?? 120_000;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'HealthcheckTimeoutMs')) {
    updated.Server.LlamaCpp.HealthcheckTimeoutMs = defaults.Server?.LlamaCpp?.HealthcheckTimeoutMs ?? 2_000;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'HealthcheckIntervalMs')) {
    updated.Server.LlamaCpp.HealthcheckIntervalMs = defaults.Server?.LlamaCpp?.HealthcheckIntervalMs ?? 1_000;
    changed = true;
  }

  if (updated.Runtime.Model === SIFT_PREVIOUS_DEFAULT_MODEL) {
    updated.Runtime.Model = null;
    changed = true;
  }

  const numCtx = Number(updated.Runtime.LlamaCpp.NumCtx);
  const ratio = Number(updated.Thresholds.ChunkThresholdRatio);
  const isLegacyDefaultSettings = (
    numCtx === SIFT_LEGACY_DEFAULT_NUM_CTX
    && (!hadExplicitMaxInputCharacters || legacyMaxInputCharactersValue === SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS)
  );
  const isLegacyDerivedSettings = (
    numCtx === SIFT_LEGACY_DERIVED_NUM_CTX
    && !hadExplicitMaxInputCharacters
    && ratio === defaults.Thresholds.ChunkThresholdRatio
  );
  const isPreviousDefaultSettings = (
    numCtx === SIFT_PREVIOUS_DEFAULT_NUM_CTX
    && !hadExplicitMaxInputCharacters
    && ratio === defaults.Thresholds.ChunkThresholdRatio
  );

  if (isLegacyDefaultSettings || isLegacyDerivedSettings || isPreviousDefaultSettings) {
    delete updated.Runtime.LlamaCpp.NumCtx;
    updated.Thresholds.ChunkThresholdRatio = defaults.Thresholds.ChunkThresholdRatio;
    delete updated.Thresholds.MaxInputCharacters;
    changed = true;
  }

  return {
    config: updated,
    info: {
      changed,
      legacyMaxInputCharactersRemoved,
      legacyMaxInputCharactersValue,
    },
  };
}

async function addEffectiveConfigProperties(config: SiftConfig, info: NormalizationInfo): Promise<SiftConfig> {
  const effectiveBudget = await resolveInputCharactersPerContextToken();
  const missingRuntimeFields = getMissingRuntimeFields(config);
  const runtimeConfigReady = missingRuntimeFields.length === 0;
  const numCtx = runtimeConfigReady ? getConfiguredLlamaNumCtx(config) : null;
  const maxInputCharacters = numCtx === null
    ? null
    : getDerivedMaxInputCharacters(numCtx, effectiveBudget.value);
  const chunkThresholdRatio = Number(config.Thresholds.ChunkThresholdRatio);
  const effectiveChunkThresholdRatio = chunkThresholdRatio > 0 && chunkThresholdRatio <= 1 ? chunkThresholdRatio : 0.92;
  return {
    ...config,
    Effective: {
      ConfigAuthoritative: true,
      RuntimeConfigReady: runtimeConfigReady,
      MissingRuntimeFields: missingRuntimeFields,
      BudgetSource: effectiveBudget.budgetSource,
      NumCtx: numCtx,
      InputCharactersPerContextToken: effectiveBudget.value,
      ObservedTelemetrySeen: effectiveBudget.budgetSource !== 'ColdStartFixedCharsPerToken',
      ObservedTelemetryUpdatedAtUtc: readObservedBudgetState().updatedAtUtc,
      MaxInputCharacters: maxInputCharacters,
      ChunkThresholdRatio: chunkThresholdRatio,
      ChunkThresholdCharacters: maxInputCharacters === null ? null : Math.max(Math.floor(maxInputCharacters * effectiveChunkThresholdRatio), 1),
      LegacyMaxInputCharactersRemoved: info.legacyMaxInputCharactersRemoved,
      LegacyMaxInputCharactersValue: info.legacyMaxInputCharactersValue,
    },
  };
}

async function getConfigFromService(): Promise<SiftConfig> {
  try {
    return await requestJson<SiftConfig>({
      url: getConfigServiceUrl(),
      method: 'GET',
      timeoutMs: 130_000,
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

async function setConfigInService(config: SiftConfig): Promise<SiftConfig> {
  try {
    return await requestJson<SiftConfig>({
      url: getConfigServiceUrl(),
      method: 'PUT',
      timeoutMs: 2000,
      body: JSON.stringify(toPersistedConfigObject(config)),
    });
  } catch {
    throw toStatusServerUnavailableError();
  }
}

export async function saveConfig(config: SiftConfig): Promise<SiftConfig> {
  return setConfigInService(config);
}

export async function loadConfig(options?: {
  ensure?: boolean;
}): Promise<SiftConfig> {
  void options;
  let config = await getConfigFromService();

  const update = normalizeConfig(config);
  if (update.info.changed) {
    await saveConfig(update.config);
  }

  const runtimeBackfilled = applyRuntimeCompatibilityView(update.config);
  return addEffectiveConfigProperties(updateRuntimePaths(runtimeBackfilled), update.info);
}

export async function setTopLevelConfigKey(key: string, value: unknown): Promise<SiftConfig> {
  const config = await loadConfig({ ensure: true });
  if (!Object.prototype.hasOwnProperty.call(config, key)) {
    throw new Error(`Unknown top-level config key: ${key}`);
  }

  (config as Record<string, unknown>)[key] = value;
  await saveConfig(config);
  return loadConfig({ ensure: true });
}
