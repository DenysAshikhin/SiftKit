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
export const SIFT_PREVIOUS_DEFAULT_MODEL = 'qwen3.5:4b-q8_0';
export const SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = 32_000;
export const SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = 2.5;

export type SiftConfig = {
  Version: string;
  Backend: string;
  Model: string;
  PolicyMode: string;
  RawLogRetention: boolean;
  Ollama: {
    BaseUrl: string;
    ExecutablePath: string | null;
    NumCtx: number;
    Temperature: number;
    TopP: number;
    TopK: number;
    MinP: number;
    PresencePenalty: number;
    RepetitionPenalty: number;
    NumPredict?: number | null;
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
  Paths?: {
    RuntimeRoot: string;
    Logs: string;
    EvalFixtures: string;
    EvalResults: string;
  };
  Effective?: {
    ConfigAuthoritative: boolean;
    BudgetSource: string;
    NumCtx: number;
    MaxInputCharacters: number;
    ChunkThresholdRatio: number;
    ChunkThresholdCharacters: number;
    LegacyMaxInputCharactersRemoved: boolean;
    LegacyMaxInputCharactersValue: number | null;
  };
};

type NormalizationInfo = {
  changed: boolean;
  legacyMaxInputCharactersRemoved: boolean;
  legacyMaxInputCharactersValue: number | null;
};

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

export function saveContentAtomically(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  ensureDirectory(directory);
  const tempPath = path.join(directory, `${Math.random().toString(16).slice(2)}.tmp`);
  writeUtf8NoBom(tempPath, content);
  fs.renameSync(tempPath, filePath);
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

export function getDerivedMaxInputCharacters(numCtx: number): number {
  const effectiveNumCtx = numCtx > 0 ? numCtx : getDefaultNumCtx();
  return Math.max(Math.floor(effectiveNumCtx * SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN), 1);
}

export function getEffectiveMaxInputCharacters(config: SiftConfig): number {
  return getDerivedMaxInputCharacters(Number(config.Ollama.NumCtx));
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

export function getStatusBackendUrl(): string {
  const configuredUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  if (configuredUrl && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  const host = process.env.SIFTKIT_STATUS_HOST?.trim() || '127.0.0.1';
  const port = process.env.SIFTKIT_STATUS_PORT?.trim() || '4765';
  return `http://${host}:${port}/status`;
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
  phase?: 'leaf' | 'merge';
  chunkIndex?: number | null;
  chunkTotal?: number | null;
}): Promise<void> {
  const body: Record<string, unknown> = {
    running: options.running,
    status: options.running ? 'true' : 'false',
    statusPath: getInferenceStatusPath(),
    updatedAtUtc: new Date().toISOString(),
  };

  if (options.running && options.promptCharacterCount !== undefined && options.promptCharacterCount !== null) {
    body.promptCharacterCount = options.promptCharacterCount;
  }
  if (options.running && options.rawInputCharacterCount !== undefined && options.rawInputCharacterCount !== null) {
    body.rawInputCharacterCount = options.rawInputCharacterCount;
  }
  if (options.running && options.chunkInputCharacterCount !== undefined && options.chunkInputCharacterCount !== null) {
    body.chunkInputCharacterCount = options.chunkInputCharacterCount;
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

export function findOllamaExecutable(): string | null {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, process.platform === 'win32' ? 'ollama.exe' : 'ollama');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getDefaultConfigObject(): SiftConfig {
  const runtimePaths = initializeRuntime();
  return {
    Version: SIFTKIT_VERSION,
    Backend: 'ollama',
    Model: 'qwen3.5:9b-q4_K_M',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    Ollama: {
      BaseUrl: 'http://127.0.0.1:11434',
      ExecutablePath: null,
      NumCtx: getDefaultNumCtx(),
      Temperature: 0.2,
      TopP: 0.95,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 0.0,
      RepetitionPenalty: 1.0,
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
    Paths: runtimePaths,
  };
}

function toPersistedConfigObject(config: SiftConfig): Omit<SiftConfig, 'Paths' | 'Effective'> {
  return {
    Version: config.Version,
    Backend: config.Backend,
    Model: config.Model,
    PolicyMode: config.PolicyMode,
    RawLogRetention: Boolean(config.RawLogRetention),
    Ollama: {
      BaseUrl: config.Ollama.BaseUrl,
      ExecutablePath: config.Ollama.ExecutablePath,
      NumCtx: Number(config.Ollama.NumCtx),
      Temperature: Number(config.Ollama.Temperature),
      TopP: Number(config.Ollama.TopP),
      TopK: Number(config.Ollama.TopK),
      MinP: Number(config.Ollama.MinP),
      PresencePenalty: Number(config.Ollama.PresencePenalty),
      RepetitionPenalty: Number(config.Ollama.RepetitionPenalty),
      ...(config.Ollama.NumPredict === undefined ? {} : { NumPredict: config.Ollama.NumPredict }),
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
  };
}

function updateRuntimePaths(config: SiftConfig): SiftConfig {
  return {
    ...config,
    Paths: initializeRuntime(),
  };
}

function normalizeConfig(config: SiftConfig): { config: SiftConfig; info: NormalizationInfo } {
  const updated = JSON.parse(JSON.stringify(config)) as SiftConfig;
  const defaults = getDefaultConfigObject();
  let changed = false;
  let legacyMaxInputCharactersValue: number | null = null;
  let legacyMaxInputCharactersRemoved = false;

  updated.Thresholds ??= { ...defaults.Thresholds };
  updated.Ollama ??= { ...defaults.Ollama };
  updated.Interactive ??= { ...defaults.Interactive };

  if (!updated.Ollama.BaseUrl) {
    updated.Ollama.BaseUrl = defaults.Ollama.BaseUrl;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Ollama, 'ExecutablePath')) {
    updated.Ollama.ExecutablePath = defaults.Ollama.ExecutablePath;
    changed = true;
  }
  if (!updated.Ollama.NumCtx || Number(updated.Ollama.NumCtx) <= 0) {
    updated.Ollama.NumCtx = defaults.Ollama.NumCtx;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Ollama, 'Temperature')) {
    updated.Ollama.Temperature = defaults.Ollama.Temperature;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Ollama, 'TopP')) {
    updated.Ollama.TopP = defaults.Ollama.TopP;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Ollama, 'TopK')) {
    updated.Ollama.TopK = defaults.Ollama.TopK;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Ollama, 'MinP')) {
    updated.Ollama.MinP = defaults.Ollama.MinP;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Ollama, 'PresencePenalty')) {
    updated.Ollama.PresencePenalty = defaults.Ollama.PresencePenalty;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(updated.Ollama, 'RepetitionPenalty')) {
    updated.Ollama.RepetitionPenalty = defaults.Ollama.RepetitionPenalty;
    changed = true;
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

  if (updated.Model === SIFT_PREVIOUS_DEFAULT_MODEL) {
    updated.Model = defaults.Model;
    changed = true;
  }

  const numCtx = Number(updated.Ollama.NumCtx);
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
    updated.Ollama.NumCtx = defaults.Ollama.NumCtx;
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

function addEffectiveConfigProperties(config: SiftConfig, info: NormalizationInfo): SiftConfig {
  return {
    ...config,
    Effective: {
      ConfigAuthoritative: true,
      BudgetSource: 'NumCtxDerived',
      NumCtx: Number(config.Ollama.NumCtx),
      MaxInputCharacters: getEffectiveMaxInputCharacters(config),
      ChunkThresholdRatio: Number(config.Thresholds.ChunkThresholdRatio),
      ChunkThresholdCharacters: getChunkThresholdCharacters(config),
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
      timeoutMs: 2000,
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

  return addEffectiveConfigProperties(updateRuntimePaths(update.config), update.info);
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
