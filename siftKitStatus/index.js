const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
const DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-35B-4bit-150k-no-thinking.ps1';
const DEFAULT_LLAMA_SHUTDOWN_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\stop-llama-server.ps1';
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const EXECUTION_LEASE_STALE_MS = 10_000;
const IDLE_SUMMARY_DELAY_MS = getPositiveIntegerFromEnv('SIFTKIT_IDLE_SUMMARY_DELAY_MS', 60_000);
const GPU_LOCK_POLL_DELAY_MS = 100;
const LLAMA_STARTUP_GRACE_DELAY_MS = 2_000;
const MAX_LLAMA_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_LLAMA_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS = 2_000;
const DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS = 1_000;
const MANAGED_LLAMA_LOG_ALERT_PATTERN = /\b(?:warn(?:ing)?|error|exception|fatal)\b/iu;
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
];
const STATUS_TRUE = 'true';
const STATUS_FALSE = 'false';
const STATUS_LOCK_REQUESTED = 'lock_requested';
const STATUS_FOREIGN_LOCK = 'foreign_lock';

function getPositiveIntegerFromEnv(name, fallback) {
  const rawValue = process.env[name];
  if (!rawValue || !rawValue.trim()) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return parsedValue;
}

function getRuntimeRoot() {
  const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  if (configuredPath && configuredPath.trim()) {
    const statusPath = path.resolve(configuredPath);
    const statusDirectory = path.dirname(statusPath);
    if (path.basename(statusDirectory).toLowerCase() === 'status') {
      return path.dirname(statusDirectory);
    }

    return statusDirectory;
  }

  return path.join(process.env.USERPROFILE || os.homedir(), '.siftkit');
}

function getStatusPath() {
  const configuredPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.join(getRuntimeRoot(), 'status', 'inference.txt');
}

function getConfigPath() {
  const configuredPath = process.env.SIFTKIT_CONFIG_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.join(getRuntimeRoot(), 'config.json');
}

function getMetricsPath() {
  const configuredPath = process.env.SIFTKIT_METRICS_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.join(getRuntimeRoot(), 'metrics', 'compression.json');
}

function getIdleSummarySnapshotsPath() {
  const configuredPath = process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath);
  }

  return path.join(path.dirname(getStatusPath()), 'idle-summary.sqlite');
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function writeText(targetPath, content) {
  ensureDirectory(targetPath);
  fs.writeFileSync(targetPath, content, 'utf8');
}

function normalizeStatusText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === STATUS_TRUE ||
    normalized === STATUS_FALSE ||
    normalized === STATUS_LOCK_REQUESTED ||
    normalized === STATUS_FOREIGN_LOCK
  ) {
    return normalized;
  }

  return STATUS_FALSE;
}

function ensureStatusFile(targetPath) {
  if (!fs.existsSync(targetPath)) {
    writeText(targetPath, STATUS_FALSE);
  }
}

function getDefaultMetrics() {
  return {
    inputCharactersTotal: 0,
    outputCharactersTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    thinkingTokensTotal: 0,
    requestDurationMsTotal: 0,
    completedRequestCount: 0,
    updatedAtUtc: null
  };
}

function normalizeMetrics(input) {
  const metrics = getDefaultMetrics();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return metrics;
  }

  if (Number.isFinite(input.inputCharactersTotal) && input.inputCharactersTotal >= 0) {
    metrics.inputCharactersTotal = Number(input.inputCharactersTotal);
  }
  if (Number.isFinite(input.outputCharactersTotal) && input.outputCharactersTotal >= 0) {
    metrics.outputCharactersTotal = Number(input.outputCharactersTotal);
  }
  if (Number.isFinite(input.inputTokensTotal) && input.inputTokensTotal >= 0) {
    metrics.inputTokensTotal = Number(input.inputTokensTotal);
  }
  if (Number.isFinite(input.outputTokensTotal) && input.outputTokensTotal >= 0) {
    metrics.outputTokensTotal = Number(input.outputTokensTotal);
  }
  if (Number.isFinite(input.thinkingTokensTotal) && input.thinkingTokensTotal >= 0) {
    metrics.thinkingTokensTotal = Number(input.thinkingTokensTotal);
  }
  if (Number.isFinite(input.requestDurationMsTotal) && input.requestDurationMsTotal >= 0) {
    metrics.requestDurationMsTotal = Number(input.requestDurationMsTotal);
  }
  if (Number.isFinite(input.completedRequestCount) && input.completedRequestCount >= 0) {
    metrics.completedRequestCount = Number(input.completedRequestCount);
  }
  if (typeof input.updatedAtUtc === 'string' && input.updatedAtUtc.trim()) {
    metrics.updatedAtUtc = input.updatedAtUtc;
  }

  return metrics;
}

function readMetrics(metricsPath) {
  if (!fs.existsSync(metricsPath)) {
    return getDefaultMetrics();
  }

  try {
    return normalizeMetrics(JSON.parse(fs.readFileSync(metricsPath, 'utf8')));
  } catch {
    return getDefaultMetrics();
  }
}

function writeMetrics(metricsPath, metrics) {
  writeText(metricsPath, `${JSON.stringify(normalizeMetrics(metrics), null, 2)}\n`);
}

function getDefaultConfig() {
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    PromptPrefix: 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.',
    LlamaCpp: {
      BaseUrl: DEFAULT_LLAMA_BASE_URL,
      NumCtx: 150000,
      ModelPath: DEFAULT_LLAMA_MODEL_PATH,
      Temperature: 0.7,
      TopP: 0.8,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 1.5,
      RepetitionPenalty: 1.0,
      MaxTokens: 15000,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Runtime: {
      Model: DEFAULT_LLAMA_MODEL,
      LlamaCpp: {
        BaseUrl: DEFAULT_LLAMA_BASE_URL,
        NumCtx: 150000,
        ModelPath: DEFAULT_LLAMA_MODEL_PATH,
        Temperature: 0.7,
        TopP: 0.8,
        TopK: 20,
        MinP: 0.0,
        PresencePenalty: 1.5,
        RepetitionPenalty: 1.0,
        MaxTokens: 15000,
        FlashAttention: true,
        ParallelSlots: 1,
        Reasoning: 'off',
      }
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
      ChunkThresholdRatio: 0.92
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true
    },
    Server: {
      LlamaCpp: {
        StartupScript: DEFAULT_LLAMA_STARTUP_SCRIPT,
        ShutdownScript: DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
        StartupTimeoutMs: DEFAULT_LLAMA_STARTUP_TIMEOUT_MS,
        HealthcheckTimeoutMs: DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS,
        HealthcheckIntervalMs: DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS,
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeConfig(baseValue, patchValue) {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }

  if (
    baseValue &&
    patchValue &&
    typeof baseValue === 'object' &&
    typeof patchValue === 'object' &&
    !Array.isArray(baseValue) &&
    !Array.isArray(patchValue)
  ) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(patchValue)) {
      if (key === 'Paths') {
        continue;
      }

      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    return merged;
  }

  return patchValue;
}

function normalizeConfig(input) {
  const merged = mergeConfig(getDefaultConfig(), input || {});
  if (merged.Backend === 'ollama') {
    merged.Backend = 'llama.cpp';
  }
  merged.LlamaCpp = (merged.LlamaCpp && typeof merged.LlamaCpp === 'object') ? merged.LlamaCpp : {};
  merged.Runtime = (merged.Runtime && typeof merged.Runtime === 'object') ? merged.Runtime : {};
  merged.Runtime.LlamaCpp = (merged.Runtime.LlamaCpp && typeof merged.Runtime.LlamaCpp === 'object') ? merged.Runtime.LlamaCpp : {};
  if (merged.Ollama) {
    if (merged.Ollama.BaseUrl !== undefined) {
      merged.Runtime.LlamaCpp.BaseUrl = merged.Runtime.LlamaCpp.BaseUrl ?? merged.Ollama.BaseUrl;
    }
    if (merged.Ollama.NumCtx !== undefined) {
      merged.Runtime.LlamaCpp.NumCtx = merged.Runtime.LlamaCpp.NumCtx ?? Number(merged.Ollama.NumCtx);
    }
    if (merged.Ollama.Temperature !== undefined) {
      merged.Runtime.LlamaCpp.Temperature = merged.Runtime.LlamaCpp.Temperature ?? Number(merged.Ollama.Temperature);
    }
    if (merged.Ollama.TopP !== undefined) {
      merged.Runtime.LlamaCpp.TopP = merged.Runtime.LlamaCpp.TopP ?? Number(merged.Ollama.TopP);
    }
    if (merged.Ollama.TopK !== undefined) {
      merged.Runtime.LlamaCpp.TopK = merged.Runtime.LlamaCpp.TopK ?? Number(merged.Ollama.TopK);
    }
    if (merged.Ollama.MinP !== undefined) {
      merged.Runtime.LlamaCpp.MinP = merged.Runtime.LlamaCpp.MinP ?? Number(merged.Ollama.MinP);
    }
    if (merged.Ollama.PresencePenalty !== undefined) {
      merged.Runtime.LlamaCpp.PresencePenalty = merged.Runtime.LlamaCpp.PresencePenalty ?? Number(merged.Ollama.PresencePenalty);
    }
    if (merged.Ollama.RepetitionPenalty !== undefined) {
      merged.Runtime.LlamaCpp.RepetitionPenalty = merged.Runtime.LlamaCpp.RepetitionPenalty ?? Number(merged.Ollama.RepetitionPenalty);
    }
    if (Object.prototype.hasOwnProperty.call(merged.Ollama, 'NumPredict')) {
      merged.Runtime.LlamaCpp.MaxTokens = merged.Runtime.LlamaCpp.MaxTokens ?? merged.Ollama.NumPredict;
    }
  }
  delete merged.Ollama;
  delete merged.Paths;
  merged.Server = (merged.Server && typeof merged.Server === 'object') ? merged.Server : {};
  merged.Server.LlamaCpp = (merged.Server.LlamaCpp && typeof merged.Server.LlamaCpp === 'object') ? merged.Server.LlamaCpp : {};
  if (typeof merged.Model === 'string' && merged.Model.trim() && !merged.Runtime.Model) {
    merged.Runtime.Model = merged.Model;
  }
  delete merged.Model;
  if ((!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) && typeof merged.Runtime.PromptPrefix === 'string' && merged.Runtime.PromptPrefix.trim()) {
    merged.PromptPrefix = merged.Runtime.PromptPrefix;
  }
  delete merged.Runtime.PromptPrefix;
  if (!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) {
    merged.PromptPrefix = getDefaultConfig().PromptPrefix;
  }
  if (merged.Thresholds && typeof merged.Thresholds === 'object') {
    delete merged.Thresholds.MaxInputCharacters;
  }
  if (merged.LlamaCpp && typeof merged.LlamaCpp === 'object') {
    for (const key of RUNTIME_OWNED_LLAMA_CPP_KEYS) {
      if (Object.prototype.hasOwnProperty.call(merged.LlamaCpp, key)) {
        if (!Object.prototype.hasOwnProperty.call(merged.Runtime.LlamaCpp, key)) {
          merged.Runtime.LlamaCpp[key] = merged.LlamaCpp[key];
        }
        delete merged.LlamaCpp[key];
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(merged.Server.LlamaCpp, 'StartupScript')) {
    merged.Server.LlamaCpp.StartupScript = null;
  }
  if (!Object.prototype.hasOwnProperty.call(merged.Server.LlamaCpp, 'ShutdownScript')) {
    merged.Server.LlamaCpp.ShutdownScript = null;
  }
  if (!Object.prototype.hasOwnProperty.call(merged.Server.LlamaCpp, 'StartupTimeoutMs')) {
    merged.Server.LlamaCpp.StartupTimeoutMs = DEFAULT_LLAMA_STARTUP_TIMEOUT_MS;
  }
  if (!Object.prototype.hasOwnProperty.call(merged.Server.LlamaCpp, 'HealthcheckTimeoutMs')) {
    merged.Server.LlamaCpp.HealthcheckTimeoutMs = DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS;
  }
  if (!Object.prototype.hasOwnProperty.call(merged.Server.LlamaCpp, 'HealthcheckIntervalMs')) {
    merged.Server.LlamaCpp.HealthcheckIntervalMs = DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS;
  }
  return merged;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return normalizeConfig({});
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig({});
  }
}

function writeConfig(configPath, config) {
  writeText(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}

function getFinitePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getManagedStartupTimeoutMs(value, fallback) {
  return Math.min(getFinitePositiveInteger(value, fallback), MAX_LLAMA_STARTUP_TIMEOUT_MS);
}

function requestText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          body,
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs} ms.`));
    });
    request.on('error', reject);
    request.end();
  });
}

function getCompatRuntimeLlamaCpp(config) {
  return config?.Runtime?.LlamaCpp ?? config?.LlamaCpp ?? {};
}

function getLlamaBaseUrl(config) {
  const baseUrl = getCompatRuntimeLlamaCpp(config).BaseUrl;
  return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : null;
}

function getManagedLlamaConfig(config) {
  const defaults = getDefaultConfig().Server.LlamaCpp;
  const serverLlama = config?.Server?.LlamaCpp ?? {};
  return {
    StartupScript: typeof serverLlama.StartupScript === 'string' && serverLlama.StartupScript.trim() ? serverLlama.StartupScript.trim() : null,
    ShutdownScript: typeof serverLlama.ShutdownScript === 'string' && serverLlama.ShutdownScript.trim() ? serverLlama.ShutdownScript.trim() : null,
    StartupTimeoutMs: getManagedStartupTimeoutMs(serverLlama.StartupTimeoutMs, defaults.StartupTimeoutMs),
    HealthcheckTimeoutMs: getFinitePositiveInteger(serverLlama.HealthcheckTimeoutMs, defaults.HealthcheckTimeoutMs),
    HealthcheckIntervalMs: getFinitePositiveInteger(serverLlama.HealthcheckIntervalMs, defaults.HealthcheckIntervalMs),
  };
}

function resolveManagedScriptPath(scriptPath, configPath) {
  if (!scriptPath || !scriptPath.trim()) {
    return null;
  }

  return path.isAbsolute(scriptPath)
    ? path.resolve(scriptPath)
    : path.resolve(path.dirname(configPath), scriptPath);
}

function getManagedLlamaLogRoot() {
  return path.join(getRuntimeRoot(), 'logs', 'managed-llama');
}

function createManagedLlamaLogPaths(purpose) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const suffix = crypto.randomUUID().slice(0, 8);
  const directory = path.join(getManagedLlamaLogRoot(), `${timestamp}-${suffix}-${purpose}`);
  ensureDirectory(path.join(directory, 'placeholder.txt'));
  return {
    directory,
    scriptStdoutPath: path.join(directory, 'script.stdout.log'),
    scriptStderrPath: path.join(directory, 'script.stderr.log'),
    llamaStdoutPath: path.join(directory, 'llama.stdout.log'),
    llamaStderrPath: path.join(directory, 'llama.stderr.log'),
    startupDumpPath: path.join(directory, 'startup-review.log'),
    latestStartupDumpPath: path.join(getManagedLlamaLogRoot(), 'latest-startup.log'),
    failureDumpPath: path.join(directory, 'startup-scan-failure.log'),
  };
}

function readTextIfExists(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) {
      return '';
    }
    return fs.readFileSync(targetPath, 'utf8');
  } catch {
    return '';
  }
}

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(Math.floor(milliseconds / 1000), 0);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}:${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  return `${seconds}s`;
}

function formatGroupedNumber(value, fractionDigits = null) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  const numericValue = Number(value);
  const useGrouping = Math.abs(numericValue) >= 1000;
  if (fractionDigits === null) {
    return useGrouping
      ? numericValue.toLocaleString('en-US', { maximumFractionDigits: 20 })
      : String(numericValue);
  }

  if (!useGrouping) {
    return numericValue.toFixed(fractionDigits);
  }

  return numericValue.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatInteger(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return formatGroupedNumber(Math.trunc(Number(value)));
}

function formatMilliseconds(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return 'n/a';
  }

  return `${formatGroupedNumber(milliseconds, 2)}ms`;
}

function formatSeconds(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return 'n/a';
  }

  return `${formatGroupedNumber(milliseconds / 1000, 2)}s`;
}

function formatPercentage(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${formatGroupedNumber(Number(value) * 100, 2)}%`;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${formatGroupedNumber(value, 2)}x`;
}

function formatTokensPerSecond(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 'n/a';
  }

  return formatGroupedNumber(value, 2);
}

function supportsAnsiColor(options = {}) {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdout && process.stdout.isTTY);
  return isTTY && !Object.prototype.hasOwnProperty.call(env, 'NO_COLOR');
}

function colorize(text, colorCode, options = {}) {
  if (!supportsAnsiColor(options)) {
    return text;
  }

  return `\x1b[${colorCode}m${text}\x1b[0m`;
}

function formatIdleSummarySection(label, content, colorCode, colorOptions = {}) {
  const visibleLabel = `${label}:`;
  const spacing = ' '.repeat(Math.max(1, 8 - visibleLabel.length));
  return `  ${colorize(label, colorCode, colorOptions)}:${spacing}${content}`;
}

function buildIdleSummarySnapshot(metrics, emittedAt = new Date()) {
  const inputTokensTotal = Number(metrics.inputTokensTotal) || 0;
  const outputTokensTotal = Number(metrics.outputTokensTotal) || 0;
  const thinkingTokensTotal = Number(metrics.thinkingTokensTotal) || 0;
  const inputCharactersTotal = Number(metrics.inputCharactersTotal) || 0;
  const outputCharactersTotal = Number(metrics.outputCharactersTotal) || 0;
  const requestDurationMsTotal = Number(metrics.requestDurationMsTotal) || 0;
  const completedRequestCount = Number(metrics.completedRequestCount) || 0;
  const savedTokens = inputTokensTotal - outputTokensTotal;
  const savedPercent = inputTokensTotal > 0 ? savedTokens / inputTokensTotal : Number.NaN;
  const compressionRatio = outputTokensTotal > 0 ? inputTokensTotal / outputTokensTotal : Number.NaN;
  const avgRequestMs = completedRequestCount > 0 ? requestDurationMsTotal / completedRequestCount : Number.NaN;
  const avgTokensPerSecond = requestDurationMsTotal > 0 && outputTokensTotal > 0
    ? outputTokensTotal / (requestDurationMsTotal / 1000)
    : Number.NaN;

  return {
    emittedAtUtc: emittedAt.toISOString(),
    inputTokensTotal,
    outputTokensTotal,
    thinkingTokensTotal,
    inputCharactersTotal,
    outputCharactersTotal,
    requestDurationMsTotal,
    completedRequestCount,
    savedTokens,
    savedPercent,
    compressionRatio,
    avgRequestMs,
    avgTokensPerSecond
  };
}

function buildIdleSummarySnapshotMessage(snapshot, colorOptions = {}) {
  return [
    `requests=${formatInteger(snapshot.completedRequestCount)}`,
    formatIdleSummarySection('input', `chars=${formatInteger(snapshot.inputCharactersTotal)} tokens=${formatInteger(snapshot.inputTokensTotal)}`, 36, colorOptions),
    formatIdleSummarySection('output', `chars=${formatInteger(snapshot.outputCharactersTotal)} tokens=${formatInteger(snapshot.outputTokensTotal)}`, 32, colorOptions),
    formatIdleSummarySection('saved', `tokens=${formatInteger(snapshot.savedTokens)} pct=${formatPercentage(snapshot.savedPercent)} ratio=${formatRatio(snapshot.compressionRatio)}`, 33, colorOptions),
    formatIdleSummarySection('timing', `total=${formatElapsed(snapshot.requestDurationMsTotal)} avg_request=${formatSeconds(snapshot.avgRequestMs)} avg_tokens_per_s=${formatTokensPerSecond(snapshot.avgTokensPerSecond)}`, 34, colorOptions)
  ].join('\n');
}

function normalizeSqlNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function ensureIdleSummarySnapshotsTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS idle_summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emitted_at_utc TEXT NOT NULL,
      completed_request_count INTEGER NOT NULL,
      input_characters_total INTEGER NOT NULL,
      output_characters_total INTEGER NOT NULL,
      input_tokens_total INTEGER NOT NULL,
      output_tokens_total INTEGER NOT NULL,
      thinking_tokens_total INTEGER NOT NULL,
      saved_tokens INTEGER NOT NULL,
      saved_percent REAL,
      compression_ratio REAL,
      request_duration_ms_total INTEGER NOT NULL,
      avg_request_ms REAL,
      avg_tokens_per_second REAL
    );
  `);

  const existingColumns = database.prepare('PRAGMA table_info(idle_summary_snapshots)').all()
    .map((column) => String(column.name));
  if (!existingColumns.includes('thinking_tokens_total')) {
    database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN thinking_tokens_total INTEGER NOT NULL DEFAULT 0;');
  }
}

function persistIdleSummarySnapshot(database, snapshot) {
  database.prepare(`
    INSERT INTO idle_summary_snapshots (
      emitted_at_utc,
      completed_request_count,
      input_characters_total,
      output_characters_total,
      input_tokens_total,
      output_tokens_total,
      thinking_tokens_total,
      saved_tokens,
      saved_percent,
      compression_ratio,
      request_duration_ms_total,
      avg_request_ms,
      avg_tokens_per_second
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.emittedAtUtc,
    snapshot.completedRequestCount,
    snapshot.inputCharactersTotal,
    snapshot.outputCharactersTotal,
    snapshot.inputTokensTotal,
    snapshot.outputTokensTotal,
    snapshot.thinkingTokensTotal,
    snapshot.savedTokens,
    normalizeSqlNumber(snapshot.savedPercent),
    normalizeSqlNumber(snapshot.compressionRatio),
    snapshot.requestDurationMsTotal,
    normalizeSqlNumber(snapshot.avgRequestMs),
    normalizeSqlNumber(snapshot.avgTokensPerSecond)
  );
}

function buildStatusRequestLogMessage({
  running,
  statusPath,
  characterCount = null,
  promptCharacterCount = null,
  rawInputCharacterCount = null,
  chunkInputCharacterCount = null,
  budgetSource = null,
  inputCharactersPerContextToken = null,
  chunkThresholdCharacters = null,
  chunkIndex = null,
  chunkTotal = null,
  elapsedMs = null,
  totalElapsedMs = null
}) {
  const statusText = running ? 'true' : 'false';
  let logMessage = `request ${statusText}`;

  if (running) {
    const resolvedPromptCharacterCount = promptCharacterCount ?? characterCount;
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${formatInteger(rawInputCharacterCount)}`;
    }
    if (chunkInputCharacterCount !== null) {
      logMessage += ` chunk_input_chars=${formatInteger(chunkInputCharacterCount)}`;
    }
    if (resolvedPromptCharacterCount !== null) {
      logMessage += ` prompt_chars=${formatInteger(resolvedPromptCharacterCount)}`;
    }
    if (budgetSource !== null) {
      logMessage += ` budget=${String(budgetSource)}`;
    }
    if (inputCharactersPerContextToken !== null) {
      logMessage += ` chars_per_token=${Number(inputCharactersPerContextToken).toFixed(3)}`;
    }
    if (chunkThresholdCharacters !== null) {
      logMessage += ` chunk_threshold_chars=${formatInteger(chunkThresholdCharacters)}`;
    }
    if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
  } else if (totalElapsedMs !== null) {
    logMessage += ` total_elapsed=${formatElapsed(totalElapsedMs)}`;
  } else if (elapsedMs !== null) {
    logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
  }

  return logMessage;
}

function buildIdleMetricsLogMessage(metrics, colorOptions = {}) {
  return buildIdleSummarySnapshotMessage(buildIdleSummarySnapshot(metrics), colorOptions);
}

function logLine(message, date = new Date()) {
  process.stdout.write(`${formatTimestamp(date)} ${message}\n`);
}

function parseRunning(bodyText) {
  if (!bodyText || !bodyText.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed.running === 'boolean') {
      return parsed.running;
    }
    if (typeof parsed.status === 'string') {
      const normalized = normalizeStatusText(parsed.status);
      if (normalized === STATUS_TRUE || normalized === STATUS_FALSE) {
        return normalized === STATUS_TRUE;
      }
    }
  } catch {
    const normalized = normalizeStatusText(bodyText);
    if (normalized === STATUS_TRUE || normalized === STATUS_FALSE) {
      return normalized === STATUS_TRUE;
    }
  }

  return null;
}

function parseStatusMetadata(bodyText) {
  const metadata = {
    promptCharacterCount: null,
    rawInputCharacterCount: null,
    chunkInputCharacterCount: null,
    budgetSource: null,
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
    chunkIndex: null,
    chunkTotal: null,
    inputTokens: null,
    outputCharacterCount: null,
    outputTokens: null,
    thinkingTokens: null,
    requestDurationMs: null
  };

  if (!bodyText || !bodyText.trim()) {
    return metadata;
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (Number.isFinite(parsed.promptCharacterCount) && parsed.promptCharacterCount >= 0) {
      metadata.promptCharacterCount = parsed.promptCharacterCount;
    } else if (Number.isFinite(parsed.characterCount) && parsed.characterCount >= 0) {
      metadata.promptCharacterCount = parsed.characterCount;
    }
    if (Number.isFinite(parsed.rawInputCharacterCount) && parsed.rawInputCharacterCount >= 0) {
      metadata.rawInputCharacterCount = parsed.rawInputCharacterCount;
    }
    if (Number.isFinite(parsed.chunkInputCharacterCount) && parsed.chunkInputCharacterCount >= 0) {
      metadata.chunkInputCharacterCount = parsed.chunkInputCharacterCount;
    }
    if (typeof parsed.budgetSource === 'string' && parsed.budgetSource.trim()) {
      metadata.budgetSource = parsed.budgetSource.trim();
    }
    if (Number.isFinite(parsed.inputCharactersPerContextToken) && parsed.inputCharactersPerContextToken > 0) {
      metadata.inputCharactersPerContextToken = Number(parsed.inputCharactersPerContextToken);
    }
    if (Number.isFinite(parsed.chunkThresholdCharacters) && parsed.chunkThresholdCharacters > 0) {
      metadata.chunkThresholdCharacters = Number(parsed.chunkThresholdCharacters);
    }
    if (Number.isFinite(parsed.chunkIndex) && parsed.chunkIndex > 0) {
      metadata.chunkIndex = parsed.chunkIndex;
    }
    if (Number.isFinite(parsed.chunkTotal) && parsed.chunkTotal > 0) {
      metadata.chunkTotal = parsed.chunkTotal;
    }
    if (Number.isFinite(parsed.inputTokens) && parsed.inputTokens >= 0) {
      metadata.inputTokens = parsed.inputTokens;
    }
    if (Number.isFinite(parsed.outputCharacterCount) && parsed.outputCharacterCount >= 0) {
      metadata.outputCharacterCount = parsed.outputCharacterCount;
    }
    if (Number.isFinite(parsed.outputTokens) && parsed.outputTokens >= 0) {
      metadata.outputTokens = parsed.outputTokens;
    }
    if (Number.isFinite(parsed.thinkingTokens) && parsed.thinkingTokens >= 0) {
      metadata.thinkingTokens = parsed.thinkingTokens;
    }
    if (Number.isFinite(parsed.requestDurationMs) && parsed.requestDurationMs >= 0) {
      metadata.requestDurationMs = parsed.requestDurationMs;
    }
  } catch {
    return metadata;
  }

  return metadata;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readStatusText(targetPath) {
  try {
    return normalizeStatusText(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return STATUS_FALSE;
  }
}

function parseJsonBody(bodyText) {
  if (!bodyText || !bodyText.trim()) {
    return {};
  }

  return JSON.parse(bodyText);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function startStatusServer() {
  const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const statusPath = getStatusPath();
  const configPath = getConfigPath();
  const metricsPath = getMetricsPath();
  const idleSummarySnapshotsPath = getIdleSummarySnapshotsPath();
  ensureStatusFile(statusPath);
  writeConfig(configPath, readConfig(configPath));
  let metrics = readMetrics(metricsPath);
  writeMetrics(metricsPath, metrics);
  const activeRunsByStatusPath = new Map();
  let activeExecutionLease = null;
  let idleSummaryTimer = null;
  let idleSummaryPending = false;
  let idleSummaryDatabase = null;
  let managedLlamaStartupPromise = null;
  let managedLlamaShutdownPromise = null;
  let managedLlamaHostProcess = null;
  let managedLlamaLastStartupLogs = null;
  let managedLlamaStarting = false;
  let managedLlamaReady = false;
  let bootstrapManagedLlamaStartup = false;
  let siftKitOwnsGpuLock = false;
  let siftKitWaitingForGpuLock = false;
  let gpuLockAcquisitionPromise = null;
  let server = null;

  function getServiceBaseUrl() {
    const address = server?.address?.();
    const port = typeof address === 'object' && address ? address.port : requestedPort;
    return `http://${host}:${port}`;
  }

  function getManagedLifecycleArgs(scriptPath) {
    return [
      '-ConfigPath', configPath,
      '-ConfigUrl', `${getServiceBaseUrl()}/config`,
      '-StatusPath', statusPath,
      '-StatusUrl', `${getServiceBaseUrl()}/status`,
      '-HealthUrl', `${getServiceBaseUrl()}/health`,
      '-RuntimeRoot', getRuntimeRoot(),
      '-ScriptPath', scriptPath,
    ];
  }

  function getManagedScriptInvocation(scriptPath) {
    const resolvedPath = resolveManagedScriptPath(scriptPath, configPath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      throw new Error(`Configured llama.cpp script does not exist: ${scriptPath}`);
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    return extension === '.ps1'
      ? {
        filePath: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath, ...getManagedLifecycleArgs(resolvedPath)],
        cwd: path.dirname(resolvedPath),
      }
      : {
        filePath: resolvedPath,
        args: getManagedLifecycleArgs(resolvedPath),
        cwd: path.dirname(resolvedPath),
      };
  }

  function spawnManagedScript(scriptPath, purpose, logPaths = createManagedLlamaLogPaths(purpose)) {
    let invocation;
    try {
      invocation = getManagedScriptInvocation(scriptPath);
    } catch (error) {
      throw new Error(`Configured llama.cpp ${purpose} script does not exist: ${scriptPath}`);
    }

    const stdoutFd = fs.openSync(logPaths.scriptStdoutPath, 'w');
    const stderrFd = fs.openSync(logPaths.scriptStderrPath, 'w');
    const child = spawn(invocation.filePath, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        SIFTKIT_SERVER_CONFIG_PATH: configPath,
        SIFTKIT_SERVER_CONFIG_URL: `${getServiceBaseUrl()}/config`,
        SIFTKIT_SERVER_STATUS_PATH: statusPath,
        SIFTKIT_SERVER_STATUS_URL: `${getServiceBaseUrl()}/status`,
        SIFTKIT_SERVER_HEALTH_URL: `${getServiceBaseUrl()}/health`,
        SIFTKIT_SERVER_RUNTIME_ROOT: getRuntimeRoot(),
        SIFTKIT_LLAMA_SCRIPT_STDOUT_PATH: logPaths.scriptStdoutPath,
        SIFTKIT_LLAMA_SCRIPT_STDERR_PATH: logPaths.scriptStderrPath,
        SIFTKIT_LLAMA_STDOUT_PATH: logPaths.llamaStdoutPath,
        SIFTKIT_LLAMA_STDERR_PATH: logPaths.llamaStderrPath,
      },
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      detached: false,
    });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    child.on('error', (error) => {
      process.stderr.write(`[siftKitStatus] llama.cpp ${purpose} script failed to spawn (${scriptPath}): ${error.message}\n`);
    });

    return {
      child,
      logPaths,
    };
  }

  function collectManagedLlamaLogEntries(logPaths) {
    const sources = [
      ['startup_script_stdout', logPaths.scriptStdoutPath],
      ['startup_script_stderr', logPaths.scriptStderrPath],
      ['llama_stdout', logPaths.llamaStdoutPath],
      ['llama_stderr', logPaths.llamaStderrPath],
    ];
    const entries = [];
    for (const [label, filePath] of sources) {
      const text = readTextIfExists(filePath);
      const matchingLines = text
        .split(/\r?\n/u)
        .filter((line) => MANAGED_LLAMA_LOG_ALERT_PATTERN.test(line));
      entries.push({
        label,
        filePath,
        text,
        matchingLines,
      });
    }

    return entries;
  }

  function collectManagedLlamaAlertMatches(logPaths) {
    return collectManagedLlamaLogEntries(logPaths)
      .filter((entry) => entry.text.trim() || entry.matchingLines.length > 0);
  }

  function writeManagedLlamaStartupReviewDump(logPaths, options = {}) {
    const entries = collectManagedLlamaLogEntries(logPaths);
    const content = [
      'Managed llama.cpp startup log dump.',
      `Result: ${options.result || 'unknown'}`,
      ...(options.baseUrl ? [`BaseUrl: ${options.baseUrl}`] : []),
      ...(options.errorMessage ? [`Error: ${options.errorMessage}`] : []),
      '',
      'Full logs:',
      ...entries.flatMap((entry) => [
        `===== ${entry.label} :: ${entry.filePath} =====`,
        entry.text.trimEnd() || '<empty>',
        '',
      ]),
    ].join('\n');
    writeText(logPaths.startupDumpPath, `${content}\n`);
    writeText(logPaths.latestStartupDumpPath, `${content}\n`);
    return logPaths.startupDumpPath;
  }

  function writeManagedLlamaFailureDump(logPaths, entries) {
    const matched = entries.filter((entry) => entry.matchingLines.length > 0);
    const content = [
      'Managed llama.cpp startup log scan failed.',
      `Pattern: ${String(MANAGED_LLAMA_LOG_ALERT_PATTERN)}`,
      '',
      'Matched lines:',
      ...matched.flatMap((entry) => [
        `${entry.label} (${entry.filePath})`,
        ...entry.matchingLines.map((line) => `  ${line}`),
      ]),
      '',
      'Full logs:',
      ...entries.flatMap((entry) => [
        `===== ${entry.label} :: ${entry.filePath} =====`,
        entry.text.trimEnd(),
        '',
      ]),
    ].join('\n');
    writeText(logPaths.failureDumpPath, `${content}\n`);
    return logPaths.failureDumpPath;
  }

  function failManagedLlamaStartup(message) {
    process.stderr.write(`[siftKitStatus] ${message}\n`);
    if (require.main === module && server && typeof server.close === 'function') {
      setImmediate(() => {
        server.close(() => process.exit(1));
      });
    }
  }

  async function scanManagedLlamaStartupLogsOrFail(logPaths) {
    const entries = collectManagedLlamaAlertMatches(logPaths);
    const matchedEntries = entries.filter((entry) => entry.matchingLines.length > 0);
    if (matchedEntries.length === 0) {
      return;
    }

    const dumpPath = writeManagedLlamaFailureDump(logPaths, entries);
    const error = new Error(`Managed llama.cpp startup logs contained warning/error markers. Dumped logs to ${dumpPath}.`);
    setImmediate(() => {
      void shutdownManagedLlamaIfNeeded().finally(() => {
        failManagedLlamaStartup(error.message);
      });
    });
    throw error;
  }

  async function isLlamaServerReachable(config) {
    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl) {
      return false;
    }

    try {
      const response = await requestText(`${baseUrl.replace(/\/$/u, '')}/v1/models`, getManagedLlamaConfig(config).HealthcheckTimeoutMs);
      return response.statusCode > 0 && response.statusCode < 400;
    } catch {
      return false;
    }
  }

  async function waitForLlamaServerReachability(config, shouldBeReachable, deadline = null) {
    const managed = getManagedLlamaConfig(config);
    const timeoutDeadline = Number.isFinite(deadline) ? Number(deadline) : Date.now() + managed.StartupTimeoutMs;
    while (Date.now() < timeoutDeadline) {
      const reachable = await isLlamaServerReachable(config);
      if (reachable === shouldBeReachable) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, managed.HealthcheckIntervalMs));
    }

    const baseUrl = getLlamaBaseUrl(config) || '<missing>';
    throw new Error(`Timed out waiting for llama.cpp server at ${baseUrl} to become ${shouldBeReachable ? 'ready' : 'offline'}.`);
  }

  async function abortManagedLlamaStartup(config, launchedChild = null) {
    const managed = getManagedLlamaConfig(config);

    if (managed.ShutdownScript) {
      logLine(`llama_stop startup_abort script=${managed.ShutdownScript}`);
      const stopChild = spawnManagedScript(managed.ShutdownScript, 'shutdown').child;
      await new Promise((resolve, reject) => {
        stopChild.once('error', reject);
        stopChild.once('exit', (code) => {
          if ((code ?? 0) !== 0) {
            reject(new Error(`Configured llama.cpp shutdown script exited with code ${code}.`));
            return;
          }
          resolve();
        });
      });
    } else if (launchedChild && launchedChild.exitCode === null && launchedChild.signalCode === null) {
      launchedChild.kill('SIGTERM');
    }

    try {
      await waitForLlamaServerReachability(config, false);
    } finally {
      managedLlamaReady = false;
      managedLlamaHostProcess = null;
      managedLlamaLastStartupLogs = null;
    }
  }

  function dumpManagedLlamaStartupReviewToConsole(logPaths, stream = process.stderr) {
    if (!logPaths) {
      return;
    }

    const dumpText = readTextIfExists(logPaths.startupDumpPath) || readTextIfExists(logPaths.latestStartupDumpPath);
    if (!dumpText.trim()) {
      return;
    }

    stream.write(`${dumpText.trimEnd()}\n`);
  }

  async function ensureManagedLlamaReady(options = {}) {
    const config = readConfig(configPath);
    if (config.Backend !== 'llama.cpp') {
      return config;
    }

    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl) {
      return config;
    }
    const managed = getManagedLlamaConfig(config);
    const startupDeadline = Date.now() + managed.StartupTimeoutMs;

    if (managedLlamaShutdownPromise) {
      await managedLlamaShutdownPromise;
    }
    await ensureSiftKitGpuLockAcquired();
    if (await isLlamaServerReachable(config)) {
      managedLlamaReady = true;
      publishStatus();
      return config;
    }
    if (managedLlamaStartupPromise) {
      await managedLlamaStartupPromise;
      managedLlamaReady = true;
      publishStatus();
      return readConfig(configPath);
    }
    const graceDelayMs = Math.min(LLAMA_STARTUP_GRACE_DELAY_MS, Math.max(startupDeadline - Date.now(), 0));
    if (graceDelayMs > 0) {
      await sleep(graceDelayMs);
    }
    if (await isLlamaServerReachable(config)) {
      managedLlamaReady = true;
      publishStatus();
      return readConfig(configPath);
    }
    if (managedLlamaStartupPromise) {
      await managedLlamaStartupPromise;
      managedLlamaReady = true;
      publishStatus();
      return readConfig(configPath);
    }
    if (!managed.StartupScript) {
      throw new Error(`llama.cpp is not reachable at ${baseUrl} and config.Server.LlamaCpp.StartupScript is not set.`);
    }
    if (Date.now() >= startupDeadline) {
      throw new Error(`Timed out waiting for llama.cpp server at ${baseUrl} to become ready.`);
    }

    managedLlamaStarting = true;
    managedLlamaStartupPromise = (async () => {
      logLine(`llama_start starting script=${managed.StartupScript}`);
      const launched = spawnManagedScript(managed.StartupScript, 'startup');
      managedLlamaHostProcess = launched.child;
      managedLlamaLastStartupLogs = launched.logPaths;
      try {
        await waitForLlamaServerReachability(config, true, startupDeadline);
        await scanManagedLlamaStartupLogsOrFail(launched.logPaths);
        writeManagedLlamaStartupReviewDump(launched.logPaths, {
          result: 'ready',
          baseUrl,
        });
        managedLlamaReady = true;
        logLine(`llama_start ready base_url=${baseUrl}`);
      } catch (error) {
        writeManagedLlamaStartupReviewDump(launched.logPaths, {
          result: 'failed',
          baseUrl,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        managedLlamaReady = false;
        if (!/startup logs contained warning\/error markers/iu.test(error instanceof Error ? error.message : '')) {
          try {
            await abortManagedLlamaStartup(config, launched.child);
          } catch (cleanupError) {
            process.stderr.write(`[siftKitStatus] Failed to abort managed llama.cpp startup: ${cleanupError.message}\n`);
          }
        }
        throw error;
      }
    })().finally(() => {
      managedLlamaStarting = false;
      managedLlamaStartupPromise = null;
      if (!managedLlamaReady) {
        releaseSiftKitGpuLockIfIdle();
      }
    });

    await managedLlamaStartupPromise;
    return readConfig(configPath);
  }

  async function shutdownManagedLlamaIfNeeded() {
    const config = readConfig(configPath);
    if (config.Backend !== 'llama.cpp') {
      return;
    }

    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl) {
      return;
    }

    if (managedLlamaStartupPromise) {
      await managedLlamaStartupPromise;
    }
    if (managedLlamaShutdownPromise) {
      return managedLlamaShutdownPromise;
    }
    if (!await isLlamaServerReachable(config)) {
      managedLlamaReady = false;
      releaseSiftKitGpuLockIfIdle();
      return;
    }

    const managed = getManagedLlamaConfig(config);
    managedLlamaShutdownPromise = (async () => {
      if (managed.ShutdownScript) {
        logLine(`llama_stop stopping script=${managed.ShutdownScript}`);
        const stopChild = spawnManagedScript(managed.ShutdownScript, 'shutdown').child;
        await new Promise((resolve, reject) => {
          stopChild.once('error', reject);
          stopChild.once('exit', (code) => {
            if ((code ?? 0) !== 0) {
              reject(new Error(`Configured llama.cpp shutdown script exited with code ${code}.`));
              return;
            }
            resolve();
          });
        });
      } else if (managedLlamaHostProcess && managedLlamaHostProcess.exitCode === null && managedLlamaHostProcess.signalCode === null) {
        logLine(`llama_stop stopping pid=${managedLlamaHostProcess.pid ?? 0}`);
        managedLlamaHostProcess.kill('SIGTERM');
      } else {
        process.stderr.write('[siftKitStatus] llama.cpp is still reachable but no shutdown script is configured and no managed host process is active.\n');
        return;
      }

      try {
        await waitForLlamaServerReachability(config, false);
      } finally {
        managedLlamaReady = false;
        managedLlamaHostProcess = null;
        managedLlamaLastStartupLogs = null;
      }
      logLine(`llama_stop offline base_url=${baseUrl}`);
      releaseSiftKitGpuLockIfIdle();
    })().catch((error) => {
      process.stderr.write(`[siftKitStatus] Failed to stop llama.cpp server: ${error.message}\n`);
    }).finally(() => {
      managedLlamaShutdownPromise = null;
    });

    return managedLlamaShutdownPromise;
  }

  function shutdownManagedLlamaForProcessExitSync() {
    try {
      bootstrapManagedLlamaStartup = false;
      managedLlamaStarting = false;
      managedLlamaReady = false;
      idleSummaryPending = false;
      siftKitWaitingForGpuLock = false;
      siftKitOwnsGpuLock = false;
      const config = readConfig(configPath);
      if (config.Backend !== 'llama.cpp') {
        publishStatus();
        return;
      }

      const baseUrl = getLlamaBaseUrl(config);
      if (!baseUrl) {
        publishStatus();
        return;
      }

      const managed = getManagedLlamaConfig(config);
      if (managed.ShutdownScript) {
        const invocation = getManagedScriptInvocation(managed.ShutdownScript);
        const result = spawnSync(invocation.filePath, invocation.args, {
          cwd: invocation.cwd,
          env: {
            ...process.env,
            SIFTKIT_SERVER_CONFIG_PATH: configPath,
            SIFTKIT_SERVER_CONFIG_URL: `${getServiceBaseUrl()}/config`,
            SIFTKIT_SERVER_STATUS_PATH: statusPath,
            SIFTKIT_SERVER_STATUS_URL: `${getServiceBaseUrl()}/status`,
            SIFTKIT_SERVER_HEALTH_URL: `${getServiceBaseUrl()}/health`,
            SIFTKIT_SERVER_RUNTIME_ROOT: getRuntimeRoot(),
          },
          stdio: 'ignore',
          windowsHide: true,
        });

        if ((result.status ?? 0) !== 0) {
          process.stderr.write(`[siftKitStatus] Managed llama.cpp shutdown script exited with code ${result.status ?? 'null'} during process exit.\n`);
        }
        publishStatus();
        return;
      }

      if (managedLlamaHostProcess && managedLlamaHostProcess.exitCode === null && managedLlamaHostProcess.signalCode === null) {
        managedLlamaHostProcess.kill('SIGTERM');
      }
      publishStatus();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during process exit: ${error.message}\n`);
      try {
        publishStatus();
      } catch {
        // Ignore final status-file write failures during process exit.
      }
    }
  }

  async function shutdownManagedLlamaForServerExit() {
    try {
      bootstrapManagedLlamaStartup = false;
      managedLlamaStarting = false;
      siftKitWaitingForGpuLock = false;
      await shutdownManagedLlamaIfNeeded();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during server exit: ${error.message}\n`);
    } finally {
      managedLlamaReady = false;
      idleSummaryPending = false;
      releaseSiftKitGpuLockIfIdle();
    }
  }

  async function clearPreexistingManagedLlamaIfNeeded() {
    const config = readConfig(configPath);
    if (config.Backend !== 'llama.cpp') {
      return;
    }

    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl || !await isLlamaServerReachable(config)) {
      return;
    }

    const managed = getManagedLlamaConfig(config);
    if (!managed.ShutdownScript) {
      process.stderr.write(`[siftKitStatus] llama.cpp is already reachable at ${baseUrl} during server startup, but no shutdown script is configured for stale-process cleanup.\n`);
      managedLlamaReady = true;
      return;
    }

    logLine(`llama_stop startup_cleanup script=${managed.ShutdownScript}`);
    await shutdownManagedLlamaIfNeeded();
  }

  function getIdleSummaryDatabase() {
    if (idleSummaryDatabase) {
      return idleSummaryDatabase;
    }

    ensureDirectory(idleSummarySnapshotsPath);
    idleSummaryDatabase = new Database(idleSummarySnapshotsPath);
    ensureIdleSummarySnapshotsTable(idleSummaryDatabase);
    return idleSummaryDatabase;
  }

  function hasActiveRuns() {
    return activeRunsByStatusPath.has(statusPath);
  }

  function hasSiftKitGpuDemand() {
    return bootstrapManagedLlamaStartup || managedLlamaStarting || managedLlamaReady || hasActiveRuns() || idleSummaryPending || Boolean(gpuLockAcquisitionPromise);
  }

  function getPublishedStatusText() {
    if (siftKitWaitingForGpuLock) {
      return STATUS_LOCK_REQUESTED;
    }
    if (siftKitOwnsGpuLock) {
      return STATUS_TRUE;
    }

    const sharedStatus = readStatusText(statusPath);
    return sharedStatus === STATUS_FOREIGN_LOCK ? STATUS_FOREIGN_LOCK : STATUS_FALSE;
  }

  function publishStatus() {
    writeText(statusPath, getPublishedStatusText());
  }

  function releaseSiftKitGpuLockIfIdle() {
    if (hasSiftKitGpuDemand()) {
      return;
    }

    siftKitWaitingForGpuLock = false;
    siftKitOwnsGpuLock = false;
    publishStatus();
  }

  async function ensureSiftKitGpuLockAcquired() {
    if (siftKitOwnsGpuLock) {
      return;
    }
    if (gpuLockAcquisitionPromise) {
      await gpuLockAcquisitionPromise;
      return;
    }

    gpuLockAcquisitionPromise = (async () => {
      while (true) {
        const sharedStatus = readStatusText(statusPath);
        if (sharedStatus === STATUS_FALSE || sharedStatus === STATUS_TRUE) {
          siftKitWaitingForGpuLock = false;
          siftKitOwnsGpuLock = true;
          publishStatus();
          return;
        }

        siftKitWaitingForGpuLock = true;
        siftKitOwnsGpuLock = false;
        publishStatus();
        await sleep(GPU_LOCK_POLL_DELAY_MS);
      }
    })().finally(() => {
      gpuLockAcquisitionPromise = null;
    });

    await gpuLockAcquisitionPromise;
  }

  function isIdle() {
    return !hasActiveRuns() && !getActiveExecutionLease();
  }

  function clearIdleSummaryTimer() {
    if (idleSummaryTimer) {
      clearTimeout(idleSummaryTimer);
      idleSummaryTimer = null;
    }
  }

  function scheduleIdleSummaryIfNeeded() {
    if (!idleSummaryPending || !isIdle()) {
      clearIdleSummaryTimer();
      return;
    }

    clearIdleSummaryTimer();
    idleSummaryTimer = setTimeout(async () => {
      idleSummaryTimer = null;
      if (!idleSummaryPending || !isIdle()) {
        return;
      }

      const emittedAt = new Date();
      const snapshot = buildIdleSummarySnapshot(metrics, emittedAt);
      try {
        persistIdleSummarySnapshot(getIdleSummaryDatabase(), snapshot);
      } catch (error) {
        process.stderr.write(`[siftKitStatus] Failed to persist idle summary snapshot to ${idleSummarySnapshotsPath}: ${error.message}\n`);
      }
      logLine(buildIdleSummarySnapshotMessage(snapshot), emittedAt);
      idleSummaryPending = false;
      releaseSiftKitGpuLockIfIdle();
      await shutdownManagedLlamaIfNeeded();
    }, IDLE_SUMMARY_DELAY_MS);
    if (typeof idleSummaryTimer.unref === 'function') {
      idleSummaryTimer.unref();
    }
  }

  function getActiveExecutionLease() {
    if (!activeExecutionLease) {
      return null;
    }

    if ((Date.now() - activeExecutionLease.heartbeatAt) >= EXECUTION_LEASE_STALE_MS) {
      activeExecutionLease = null;
      return null;
    }

    return activeExecutionLease;
  }

  function releaseExecutionLease(token) {
    const lease = getActiveExecutionLease();
    if (!lease || lease.token !== token) {
      return false;
    }

    activeExecutionLease = null;
    scheduleIdleSummaryIfNeeded();
    return true;
  }

  const idleStatusWatchdog = setInterval(() => {
    const expectedStatus = getPublishedStatusText();
    if (readStatusText(statusPath) !== expectedStatus) {
      writeText(statusPath, expectedStatus);
    }
  }, EXECUTION_LEASE_STALE_MS);
  if (typeof idleStatusWatchdog.unref === 'function') {
    idleStatusWatchdog.unref();
  }

  server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        statusPath,
        configPath,
        metricsPath,
        idleSummarySnapshotsPath,
        runtimeRoot: getRuntimeRoot()
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const currentStatus = getPublishedStatusText();
      sendJson(res, 200, { running: currentStatus === STATUS_TRUE, status: currentStatus, statusPath, configPath, metrics, idleSummarySnapshotsPath });
      return;
    }

    if (req.method === 'GET' && req.url === '/execution') {
      const lease = getActiveExecutionLease();
      sendJson(res, 200, { busy: Boolean(lease), statusPath, configPath });
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/acquire') {
      clearIdleSummaryTimer();
      const lease = getActiveExecutionLease();
      if (lease) {
        sendJson(res, 200, { ok: true, acquired: false, busy: true });
        return;
      }

      const token = crypto.randomUUID();
      activeExecutionLease = {
        token,
        heartbeatAt: Date.now(),
      };
      sendJson(res, 200, { ok: true, acquired: true, busy: true, token });
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/heartbeat') {
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }

      if (typeof parsedBody.token !== 'string' || !parsedBody.token.trim()) {
        sendJson(res, 400, { error: 'Expected token.' });
        return;
      }

      const lease = getActiveExecutionLease();
      if (!lease || lease.token !== parsedBody.token) {
        sendJson(res, 409, { error: 'Execution lease is not active.' });
        return;
      }

      lease.heartbeatAt = Date.now();
      sendJson(res, 200, { ok: true, busy: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/release') {
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }

      if (typeof parsedBody.token !== 'string' || !parsedBody.token.trim()) {
        sendJson(res, 400, { error: 'Expected token.' });
        return;
      }

      const released = releaseExecutionLease(parsedBody.token);
      sendJson(res, released ? 200 : 409, { ok: released, released, busy: Boolean(getActiveExecutionLease()) });
      return;
    }

    if (req.method === 'POST' && req.url === '/status') {
      const bodyText = await readBody(req);
      const running = parseRunning(bodyText);
      if (running === null) {
        sendJson(res, 400, { error: 'Expected running=true|false or status=true|false.' });
        return;
      }

      const metadata = parseStatusMetadata(bodyText);
      let elapsedMs = null;
      let totalElapsedMs = null;
      let requestCompleted = false;
      if (running) {
        clearIdleSummaryTimer();
        const now = Date.now();
        const existingRun = activeRunsByStatusPath.get(statusPath);
        const needsGpuLock = !existingRun;
        const isChunkedRequest = metadata.chunkIndex !== null && metadata.chunkTotal !== null;
        let runState = existingRun;

        if (!runState) {
          runState = {
            overallStartedAt: now,
            currentRequestStartedAt: now,
            sawChunked: false,
            lastChunkIndex: null,
            lastChunkTotal: null,
            pendingFinalMerge: false,
            rawInputCharacterCount: metadata.rawInputCharacterCount,
            promptCharacterCount: metadata.promptCharacterCount
          };
        } else {
          runState.currentRequestStartedAt = now;
          if (runState.rawInputCharacterCount === null && metadata.rawInputCharacterCount !== null) {
            runState.rawInputCharacterCount = metadata.rawInputCharacterCount;
          }
          if (metadata.promptCharacterCount !== null) {
            runState.promptCharacterCount = metadata.promptCharacterCount;
          }
        }

        if (isChunkedRequest) {
          runState.sawChunked = true;
          runState.lastChunkIndex = metadata.chunkIndex;
          runState.lastChunkTotal = metadata.chunkTotal;
          runState.pendingFinalMerge = false;
        } else if (runState.sawChunked) {
          runState.pendingFinalMerge = true;
        }

        activeRunsByStatusPath.set(statusPath, runState);
        if (needsGpuLock) {
          await ensureSiftKitGpuLockAcquired();
        }
      } else {
        const runState = activeRunsByStatusPath.get(statusPath);
        if (runState && Number.isFinite(runState.currentRequestStartedAt)) {
          const now = Date.now();
          elapsedMs = now - runState.currentRequestStartedAt;
          if (metadata.promptCharacterCount === null && runState.promptCharacterCount !== null) {
            metadata.promptCharacterCount = runState.promptCharacterCount;
          }
          if (runState.sawChunked) {
            if (runState.pendingFinalMerge) {
              totalElapsedMs = now - runState.overallStartedAt;
              metadata.rawInputCharacterCount = runState.rawInputCharacterCount;
              activeRunsByStatusPath.delete(statusPath);
              requestCompleted = true;
            }
          } else {
            metadata.rawInputCharacterCount = runState.rawInputCharacterCount;
            activeRunsByStatusPath.delete(statusPath);
            requestCompleted = true;
          }
        }
        metrics = normalizeMetrics({
          ...metrics,
          inputCharactersTotal: metrics.inputCharactersTotal + (metadata.promptCharacterCount ?? 0),
          outputCharactersTotal: metrics.outputCharactersTotal + (metadata.outputCharacterCount ?? 0),
          inputTokensTotal: metrics.inputTokensTotal + (metadata.inputTokens ?? 0),
          outputTokensTotal: metrics.outputTokensTotal + (metadata.outputTokens ?? 0),
          thinkingTokensTotal: metrics.thinkingTokensTotal + (metadata.thinkingTokens ?? 0),
          requestDurationMsTotal: metrics.requestDurationMsTotal + (metadata.requestDurationMs ?? elapsedMs ?? 0),
          completedRequestCount: metrics.completedRequestCount + (requestCompleted ? 1 : 0),
          updatedAtUtc: new Date().toISOString()
        });
        writeMetrics(metricsPath, metrics);
        if (requestCompleted) {
          idleSummaryPending = true;
          scheduleIdleSummaryIfNeeded();
        }
      }
      const logMessage = buildStatusRequestLogMessage({
        running,
        statusPath,
        promptCharacterCount: metadata.promptCharacterCount,
        rawInputCharacterCount: metadata.rawInputCharacterCount,
        chunkInputCharacterCount: metadata.chunkInputCharacterCount,
        budgetSource: metadata.budgetSource,
        inputCharactersPerContextToken: metadata.inputCharactersPerContextToken,
        chunkThresholdCharacters: metadata.chunkThresholdCharacters,
        chunkIndex: metadata.chunkIndex,
        chunkTotal: metadata.chunkTotal,
        elapsedMs,
        totalElapsedMs
      });
      logLine(logMessage);
      const publishedStatus = getPublishedStatusText();
      writeText(statusPath, publishedStatus);
      sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      try {
        if (bootstrapManagedLlamaStartup && (managedLlamaStarting || managedLlamaStartupPromise)) {
          sendJson(res, 200, readConfig(configPath));
          return;
        }
        sendJson(res, 200, await ensureManagedLlamaReady());
      } catch (error) {
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'PUT' && req.url === '/config') {
      let parsedBody;
      try {
        parsedBody = JSON.parse(await readBody(req) || '{}');
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }

      const nextConfig = normalizeConfig(mergeConfig(readConfig(configPath), parsedBody));
      writeConfig(configPath, nextConfig);
      sendJson(res, 200, nextConfig);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  const originalClose = server.close.bind(server);
  let closeRequested = false;
  server.close = (callback) => {
    const finalCallback = typeof callback === 'function' ? callback : undefined;
    if (closeRequested) {
      return originalClose(finalCallback);
    }

    closeRequested = true;
    void shutdownManagedLlamaForServerExit().finally(() => {
      originalClose(finalCallback);
    });
    return server;
  };

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, async () => {
    try {
      await clearPreexistingManagedLlamaIfNeeded();
      bootstrapManagedLlamaStartup = true;
      try {
        await ensureManagedLlamaReady({ resetStatusBeforeCheck: false });
      } finally {
        bootstrapManagedLlamaStartup = false;
      }
      publishStatus();
      const address = server.address();
      process.stdout.write(`${JSON.stringify({ ok: true, port: address.port, host, statusPath, configPath })}\n`);
    } catch (error) {
      dumpManagedLlamaStartupReviewToConsole(managedLlamaLastStartupLogs);
      process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${error.message}\n`);
      server.close(() => process.exit(1));
    }
  });
  server.on('close', () => {
    clearInterval(idleStatusWatchdog);
    clearIdleSummaryTimer();
    if (idleSummaryDatabase) {
      idleSummaryDatabase.close();
      idleSummaryDatabase = null;
    }
  });
  server.shutdownManagedLlamaForServerExit = shutdownManagedLlamaForServerExit;
  server.shutdownManagedLlamaForProcessExitSync = shutdownManagedLlamaForProcessExitSync;

  return server;
}

module.exports = {
  buildIdleMetricsLogMessage,
  buildIdleSummarySnapshot,
  buildStatusRequestLogMessage,
  colorize,
  formatElapsed,
  getConfigPath,
  getIdleSummarySnapshotsPath,
  getMetricsPath,
  getStatusPath,
  supportsAnsiColor,
  startStatusServer
};

if (require.main === module) {
  const server = startStatusServer();
  let shuttingDown = false;
  const shutdown = async (signal = 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      if (typeof server.shutdownManagedLlamaForServerExit === 'function') {
        await server.shutdownManagedLlamaForServerExit();
      }
    } finally {
      server.close(() => {
        if (signal === 'SIGUSR2') {
          process.kill(process.pid, 'SIGUSR2');
          return;
        }
        process.exit(0);
      });
    }
  };

  process.on('exit', () => {
    if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
      server.shutdownManagedLlamaForProcessExitSync();
    }
  });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGUSR2', () => { void shutdown('SIGUSR2'); });
}
