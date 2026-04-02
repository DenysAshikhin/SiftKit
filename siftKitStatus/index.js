const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
const DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-35B-4bit-150k-no-thinking.ps1';
const FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k.ps1';
const BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k-thinking.ps1';
const DEFAULT_LLAMA_STARTUP_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\start-qwen35-9b-q8-200k-thinking-managed.ps1';
const DEFAULT_LLAMA_SHUTDOWN_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\stop-llama-server.ps1';
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const EXECUTION_LEASE_STALE_MS = getPositiveIntegerFromEnv('SIFTKIT_EXECUTION_LEASE_STALE_MS', 10_000);
const IDLE_SUMMARY_DELAY_MS = getPositiveIntegerFromEnv('SIFTKIT_IDLE_SUMMARY_DELAY_MS', 600_000);
const GPU_LOCK_POLL_DELAY_MS = 100;
const LLAMA_STARTUP_GRACE_DELAY_MS = 2_000;
const MAX_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
const DEFAULT_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
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

function findNearestSiftKitRepoRoot(startPath = process.cwd()) {
  let currentPath = path.resolve(startPath);
  for (;;) {
    const packagePath = path.join(currentPath, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (parsed && parsed.name === 'siftkit') {
          return currentPath;
        }
      } catch {
        // Ignore malformed package.json files while walking upward.
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
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

  const repoRoot = findNearestSiftKitRepoRoot();
  if (repoRoot) {
    return path.join(repoRoot, '.siftkit');
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

function terminateProcessTree(pid, options = {}) {
  const processObject = options.processObject || process;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }

  if (processObject.platform === 'win32') {
    try {
      const result = spawnSyncImpl('taskkill', ['/PID', String(Math.trunc(numericPid)), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if ((result?.status ?? 1) === 0) {
        return true;
      }
    } catch {
      // Fall back to process.kill below.
    }
  }

  try {
    processObject.kill(Math.trunc(numericPid), 'SIGTERM');
    return true;
  } catch {
    return false;
  }
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
      ChunkThresholdRatio: 1.0
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

function normalizeWindowsPath(value) {
  return String(value || '').replace(/\//gu, '\\').toLowerCase();
}

function isLegacyManagedStartupScriptPath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const normalized = normalizeWindowsPath(value.trim());
  return normalized === normalizeWindowsPath(PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT)
    || normalized === normalizeWindowsPath(FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT)
    || normalized === normalizeWindowsPath(BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT);
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
  if (isLegacyManagedStartupScriptPath(merged.Server.LlamaCpp.StartupScript)) {
    merged.Server.LlamaCpp.StartupScript = DEFAULT_LLAMA_STARTUP_SCRIPT;
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

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const body = typeof options.body === 'string' ? options.body : '';
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      } : undefined,
    }, (response) => {
      let responseText = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseText += chunk;
      });
      response.on('end', () => {
        if (!responseText.trim()) {
          resolve({ statusCode: response.statusCode || 0, body: {}, rawText: '' });
          return;
        }
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: JSON.parse(responseText),
            rawText: responseText,
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(Number(options.timeoutMs || 60000), () => {
      request.destroy(new Error(`Request timed out after ${Number(options.timeoutMs || 60000)} ms.`));
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
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
  const avgOutputTokensPerRequest = completedRequestCount > 0 ? outputTokensTotal / completedRequestCount : Number.NaN;
  const avgRequestMs = completedRequestCount > 0 ? requestDurationMsTotal / completedRequestCount : Number.NaN;
  const avgTokensPerSecond = requestDurationMsTotal > 0 && outputTokensTotal > 0
    ? outputTokensTotal / (requestDurationMsTotal / 1000)
    : Number.NaN;
  const inputCharactersPerContextToken = Number.isFinite(metrics.inputCharactersPerContextToken) && metrics.inputCharactersPerContextToken > 0
    ? Number(metrics.inputCharactersPerContextToken)
    : null;
  const chunkThresholdCharacters = Number.isFinite(metrics.chunkThresholdCharacters) && metrics.chunkThresholdCharacters > 0
    ? Number(metrics.chunkThresholdCharacters)
    : null;

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
    avgOutputTokensPerRequest,
    avgRequestMs,
    avgTokensPerSecond,
    inputCharactersPerContextToken,
    chunkThresholdCharacters
  };
}

function buildIdleSummarySnapshotMessage(snapshot, colorOptions = {}) {
  const lines = [
    `requests=${formatInteger(snapshot.completedRequestCount)}`,
    formatIdleSummarySection('input', `chars=${formatInteger(snapshot.inputCharactersTotal)} tokens=${formatInteger(snapshot.inputTokensTotal)}`, 36, colorOptions),
    formatIdleSummarySection('output', `chars=${formatInteger(snapshot.outputCharactersTotal)} tokens=${formatInteger(snapshot.outputTokensTotal)} avg_tokens_per_request=${formatGroupedNumber(snapshot.avgOutputTokensPerRequest, 2)}`, 32, colorOptions),
    formatIdleSummarySection('saved', `tokens=${formatInteger(snapshot.savedTokens)} pct=${formatPercentage(snapshot.savedPercent)} ratio=${formatRatio(snapshot.compressionRatio)}`, 33, colorOptions),
  ];
  const budgetParts = [];
  if (snapshot.inputCharactersPerContextToken !== null) {
    budgetParts.push(`chars_per_token=${formatGroupedNumber(snapshot.inputCharactersPerContextToken, 3)}`);
  }
  if (snapshot.chunkThresholdCharacters !== null) {
    budgetParts.push(`chunk_threshold_chars=${formatInteger(snapshot.chunkThresholdCharacters)}`);
  }
  if (budgetParts.length > 0) {
    lines.push(formatIdleSummarySection('budget', budgetParts.join(' '), 35, colorOptions));
  }
  lines.push(formatIdleSummarySection('timing', `total=${formatElapsed(snapshot.requestDurationMsTotal)} avg_request=${formatSeconds(snapshot.avgRequestMs)} gen_tokens_per_s=${formatTokensPerSecond(snapshot.avgTokensPerSecond)}`, 34, colorOptions));
  return lines.join('\n');
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
  requestId = null,
  terminalState = null,
  errorMessage = null,
  characterCount = null,
  promptCharacterCount = null,
  promptTokenCount = null,
  rawInputCharacterCount = null,
  chunkInputCharacterCount = null,
  budgetSource = null,
  inputCharactersPerContextToken = null,
  chunkThresholdCharacters = null,
  chunkIndex = null,
  chunkTotal = null,
  chunkPath = null,
  elapsedMs = null,
  totalElapsedMs = null,
  outputTokens = null,
  totalOutputTokens = null
}) {
  const statusText = running ? 'true' : 'false';
  let logMessage = `request ${statusText}`;

  if (running) {
    const resolvedPromptCharacterCount = promptCharacterCount ?? characterCount;
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${formatInteger(rawInputCharacterCount)}`;
    }
    if (resolvedPromptCharacterCount !== null) {
      logMessage += ` prompt=${formatInteger(resolvedPromptCharacterCount)}`;
      if (promptTokenCount !== null) {
        logMessage += ` (${formatInteger(promptTokenCount)})`;
      }
    }
    if (chunkPath !== null) {
      logMessage += ` chunk ${String(chunkPath)}`;
    } else if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
  } else if (terminalState === 'failed') {
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${formatInteger(rawInputCharacterCount)}`;
    }
    if (promptCharacterCount !== null) {
      logMessage += ` prompt=${formatInteger(promptCharacterCount)}`;
      if (promptTokenCount !== null) {
        logMessage += ` (${formatInteger(promptTokenCount)})`;
      }
    }
    if (chunkPath !== null) {
      logMessage += ` chunk ${String(chunkPath)}`;
    } else if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
    logMessage += ' failed';
    if (elapsedMs !== null) {
      logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
    } else if (totalElapsedMs !== null) {
      logMessage += ` elapsed=${formatElapsed(totalElapsedMs)}`;
    }
    if (errorMessage) {
      logMessage += ` error=${String(errorMessage)}`;
    }
  } else if (totalElapsedMs !== null) {
    logMessage += ` total_elapsed=${formatElapsed(totalElapsedMs)}`;
    if (totalOutputTokens !== null) {
      logMessage += ` output_tokens=${formatInteger(totalOutputTokens)}`;
    }
  } else if (elapsedMs !== null) {
    logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
    if (outputTokens !== null) {
      logMessage += ` output_tokens=${formatInteger(outputTokens)}`;
    }
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

  const parseBooleanLikeStatus = (value) => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = normalizeStatusText(value);
      if (normalized === STATUS_TRUE || normalized === STATUS_FALSE) {
        return normalized === STATUS_TRUE;
      }
    }
    return null;
  };

  try {
    const parsed = JSON.parse(bodyText);
    const running = parseBooleanLikeStatus(parsed.running);
    if (running !== null) {
      return running;
    }
    const status = parseBooleanLikeStatus(parsed.status);
    if (status !== null) {
      return status;
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
    requestId: null,
    terminalState: null,
    errorMessage: null,
    promptCharacterCount: null,
    promptTokenCount: null,
    rawInputCharacterCount: null,
    chunkInputCharacterCount: null,
    budgetSource: null,
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
    chunkIndex: null,
    chunkTotal: null,
    chunkPath: null,
    inputTokens: null,
    outputCharacterCount: null,
    outputTokens: null,
    thinkingTokens: null,
    requestDurationMs: null,
    artifactType: null,
    artifactRequestId: null,
    artifactPayload: null,
  };

  if (!bodyText || !bodyText.trim()) {
    return metadata;
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed.requestId === 'string' && parsed.requestId.trim()) {
      metadata.requestId = parsed.requestId.trim();
    }
    if (parsed.terminalState === 'completed' || parsed.terminalState === 'failed') {
      metadata.terminalState = parsed.terminalState;
    }
    if (typeof parsed.errorMessage === 'string' && parsed.errorMessage.trim()) {
      metadata.errorMessage = parsed.errorMessage.trim();
    }
    if (Number.isFinite(parsed.promptCharacterCount) && parsed.promptCharacterCount >= 0) {
      metadata.promptCharacterCount = parsed.promptCharacterCount;
    } else if (Number.isFinite(parsed.characterCount) && parsed.characterCount >= 0) {
      metadata.promptCharacterCount = parsed.characterCount;
    }
    if (Number.isFinite(parsed.promptTokenCount) && parsed.promptTokenCount >= 0) {
      metadata.promptTokenCount = parsed.promptTokenCount;
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
    if (typeof parsed.chunkPath === 'string' && parsed.chunkPath.trim()) {
      metadata.chunkPath = parsed.chunkPath.trim();
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
    if (
      parsed.artifactType === 'summary_request'
      || parsed.artifactType === 'planner_debug'
      || parsed.artifactType === 'planner_failed'
    ) {
      metadata.artifactType = parsed.artifactType;
    }
    if (typeof parsed.artifactRequestId === 'string' && parsed.artifactRequestId.trim()) {
      metadata.artifactRequestId = parsed.artifactRequestId.trim();
    }
    if (
      parsed.artifactPayload
      && typeof parsed.artifactPayload === 'object'
      && !Array.isArray(parsed.artifactPayload)
    ) {
      metadata.artifactPayload = parsed.artifactPayload;
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

function saveContentAtomically(targetPath, content) {
  ensureDirectory(targetPath);
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = path.join(
      path.dirname(targetPath),
      `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`
    );
    try {
      fs.writeFileSync(tempPath, content, 'utf8');
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
      if (!error || typeof error !== 'object') {
        break;
      }
      const code = String(error.code || '');
      if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt === 4) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to save ${targetPath}.`);
}

function getStatusArtifactPath(metadata) {
  if (!metadata.artifactType || !metadata.artifactRequestId) {
    return null;
  }

  const logsPath = path.join(getRuntimeRoot(), 'logs');
  if (metadata.artifactType === 'summary_request') {
    return path.join(logsPath, 'requests', `request_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'planner_debug') {
    return path.join(logsPath, `planner_debug_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'planner_failed') {
    return path.join(logsPath, 'failed', `request_failed_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'request_abandoned') {
    return path.join(logsPath, 'abandoned', `request_abandoned_${metadata.artifactRequestId}.json`);
  }

  return null;
}

function safeReadJson(targetPath) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

function listFiles(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return [];
  }
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetPath, entry.name));
}

function getIsoDateFromStat(targetPath) {
  try {
    return fs.statSync(targetPath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function parseRequestIdFromFileName(fileName) {
  const match = /request_(.+)\.json$/iu.exec(fileName);
  return match ? match[1] : null;
}

function normalizeRunRecord(record) {
  return {
    id: String(record.id),
    kind: String(record.kind),
    status: String(record.status),
    startedAtUtc: record.startedAtUtc || null,
    finishedAtUtc: record.finishedAtUtc || null,
    title: String(record.title || ''),
    model: record.model || null,
    backend: record.backend || null,
    inputTokens: Number.isFinite(record.inputTokens) ? Number(record.inputTokens) : null,
    outputTokens: Number.isFinite(record.outputTokens) ? Number(record.outputTokens) : null,
    thinkingTokens: Number.isFinite(record.thinkingTokens) ? Number(record.thinkingTokens) : null,
    durationMs: Number.isFinite(record.durationMs) ? Number(record.durationMs) : null,
    rawPaths: record.rawPaths && typeof record.rawPaths === 'object' ? record.rawPaths : {},
  };
}

function loadDashboardRuns(runtimeRoot) {
  const logsRoot = path.join(runtimeRoot, 'logs');
  const byId = new Map();

  for (const requestPath of listFiles(path.join(logsRoot, 'requests'))) {
    const fileName = path.basename(requestPath);
    if (!/^request_.+\.json$/iu.test(fileName)) {
      continue;
    }
    const payload = safeReadJson(requestPath);
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
      ? payload.requestId.trim()
      : parseRequestIdFromFileName(fileName);
    if (!requestId) {
      continue;
    }
    const plannerPath = path.join(logsRoot, `planner_debug_${requestId}.json`);
    const failedPath = path.join(logsRoot, 'failed', `request_failed_${requestId}.json`);
    const startedAtUtc = (
      typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
        ? payload.createdAtUtc
        : getIsoDateFromStat(requestPath)
    );
    byId.set(requestId, normalizeRunRecord({
      id: requestId,
      kind: 'summary_request',
      status: payload.error ? 'failed' : 'completed',
      startedAtUtc,
      finishedAtUtc: startedAtUtc,
      title: payload.question || payload.prompt || `Summary request ${requestId}`,
      model: payload.model || null,
      backend: payload.backend || null,
      inputTokens: payload.inputTokens ?? null,
      outputTokens: payload.outputTokens ?? null,
      thinkingTokens: payload.thinkingTokens ?? null,
      durationMs: payload.requestDurationMs ?? null,
      rawPaths: {
        request: requestPath,
        plannerDebug: fs.existsSync(plannerPath) ? plannerPath : null,
        failedRequest: fs.existsSync(failedPath) ? failedPath : null,
      },
    }));
  }

  for (const failedPath of listFiles(path.join(logsRoot, 'failed'))) {
    const fileName = path.basename(failedPath);
    const match = /^request_failed_(.+)\.json$/iu.exec(fileName);
    if (!match) {
      continue;
    }
    const payload = safeReadJson(failedPath);
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : match[1];
    const startedAtUtc = (
      typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
        ? payload.createdAtUtc
        : getIsoDateFromStat(failedPath)
    );
    if (!byId.has(requestId)) {
      byId.set(requestId, normalizeRunRecord({
        id: requestId,
        kind: 'failed_request',
        status: 'failed',
        startedAtUtc,
        finishedAtUtc: startedAtUtc,
        title: payload.question || `Failed request ${requestId}`,
        model: payload.model || null,
        backend: payload.backend || null,
        inputTokens: payload.inputTokens ?? null,
        outputTokens: payload.outputTokens ?? null,
        thinkingTokens: payload.thinkingTokens ?? null,
        durationMs: payload.requestDurationMs ?? null,
        rawPaths: { failedRequest: failedPath },
      }));
    }
  }

  for (const abandonedPath of listFiles(path.join(logsRoot, 'abandoned'))) {
    const fileName = path.basename(abandonedPath);
    const match = /^request_abandoned_(.+)\.json$/iu.exec(fileName);
    if (!match) {
      continue;
    }
    const payload = safeReadJson(abandonedPath);
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : match[1];
    const startedAtUtc = (
      typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
        ? payload.createdAtUtc
        : getIsoDateFromStat(abandonedPath)
    );
    if (!byId.has(requestId)) {
      byId.set(requestId, normalizeRunRecord({
        id: requestId,
        kind: 'request_abandoned',
        status: 'failed',
        startedAtUtc,
        finishedAtUtc: startedAtUtc,
        title: payload.reason || `Abandoned request ${requestId}`,
        model: null,
        backend: null,
        inputTokens: payload.promptTokenCount ?? null,
        outputTokens: payload.outputTokensTotal ?? null,
        thinkingTokens: null,
        durationMs: payload.totalElapsedMs ?? null,
        rawPaths: { abandonedRequest: abandonedPath },
      }));
    }
  }

  for (const folderName of ['failed', 'succesful']) {
    for (const artifactPath of listFiles(path.join(logsRoot, 'repo_search', folderName))) {
      const fileName = path.basename(artifactPath);
      if (!/^request_.+\.json$/iu.test(fileName)) {
        continue;
      }
      const payload = safeReadJson(artifactPath);
      if (!payload || typeof payload !== 'object') {
        continue;
      }
      const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
        ? payload.requestId.trim()
        : parseRequestIdFromFileName(fileName);
      if (!requestId) {
        continue;
      }
      const startedAtUtc = (
        typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
          ? payload.createdAtUtc
          : getIsoDateFromStat(artifactPath)
      );
      byId.set(requestId, normalizeRunRecord({
        id: requestId,
        kind: 'repo_search',
        status: payload.error || payload.verdict === 'fail' ? 'failed' : 'completed',
        startedAtUtc,
        finishedAtUtc: startedAtUtc,
        title: payload.prompt || `Repo search ${requestId}`,
        model: payload.model || null,
        backend: 'llama.cpp',
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        durationMs: null,
        rawPaths: {
          repoSearch: artifactPath,
          transcript: (
            typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()
          )
            ? payload.transcriptPath
            : (() => {
              const siblingTranscriptPath = artifactPath.replace(/\.json$/iu, '.jsonl');
              return fs.existsSync(siblingTranscriptPath) ? siblingTranscriptPath : null;
            })(),
        },
      }));
    }
  }

  return Array.from(byId.values()).sort((left, right) => {
    const leftTime = Date.parse(left.startedAtUtc || '1970-01-01T00:00:00.000Z');
    const rightTime = Date.parse(right.startedAtUtc || '1970-01-01T00:00:00.000Z');
    return rightTime - leftTime;
  });
}

function readJsonlEvents(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
    return [];
  }
  const content = fs.readFileSync(transcriptPath, 'utf8');
  return content
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return {
          kind: typeof parsed.kind === 'string' ? parsed.kind : 'event',
          at: typeof parsed.at === 'string' ? parsed.at : null,
          payload: parsed,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildDashboardRunDetail(runtimeRoot, runId) {
  const runs = loadDashboardRuns(runtimeRoot);
  const run = runs.find((entry) => entry.id === runId) || null;
  if (!run) {
    return null;
  }
  const events = [];
  if (run.rawPaths && typeof run.rawPaths === 'object') {
    if (run.rawPaths.transcript) {
      events.push(...readJsonlEvents(run.rawPaths.transcript));
    }
    if (run.rawPaths.request) {
      const payload = safeReadJson(run.rawPaths.request);
      if (payload) {
        events.push({ kind: 'summary_request', at: run.startedAtUtc, payload });
      }
    }
    if (run.rawPaths.plannerDebug) {
      const payload = safeReadJson(run.rawPaths.plannerDebug);
      if (payload) {
        events.push({ kind: 'planner_debug', at: run.startedAtUtc, payload });
      }
    }
    if (run.rawPaths.failedRequest) {
      const payload = safeReadJson(run.rawPaths.failedRequest);
      if (payload) {
        events.push({ kind: 'failed_request', at: run.startedAtUtc, payload });
      }
    }
    if (run.rawPaths.abandonedRequest) {
      const payload = safeReadJson(run.rawPaths.abandonedRequest);
      if (payload) {
        events.push({ kind: 'request_abandoned', at: run.startedAtUtc, payload });
      }
    }
    if (run.rawPaths.repoSearch) {
      const payload = safeReadJson(run.rawPaths.repoSearch);
      if (payload) {
        events.push({ kind: 'repo_search', at: run.startedAtUtc, payload });
      }
    }
  }
  return { run, events };
}

function buildDashboardDailyMetricsFromRuns(runtimeRoot) {
  const runs = loadDashboardRuns(runtimeRoot);
  const byDay = new Map();
  for (const run of runs) {
    const startedAt = run.startedAtUtc || new Date(0).toISOString();
    const day = startedAt.slice(0, 10);
    const current = byDay.get(day) || {
      date: day,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      successCount: 0,
      failureCount: 0,
      durationTotalMs: 0,
      durationCount: 0,
    };
    current.runs += 1;
    current.inputTokens += Number(run.inputTokens || 0);
    current.outputTokens += Number(run.outputTokens || 0);
    current.thinkingTokens += Number(run.thinkingTokens || 0);
    if (run.status === 'completed') {
      current.successCount += 1;
    } else {
      current.failureCount += 1;
    }
    if (Number.isFinite(run.durationMs) && run.durationMs >= 0) {
      current.durationTotalMs += run.durationMs;
      current.durationCount += 1;
    }
    byDay.set(day, current);
  }
  return Array.from(byDay.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((entry) => ({
      date: entry.date,
      runs: entry.runs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}

function buildDashboardDailyMetricsFromIdleSnapshots(database) {
  if (!database) {
    return [];
  }
  const rows = database
    .prepare(`
      SELECT
        emitted_at_utc,
        completed_request_count,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        request_duration_ms_total
      FROM idle_summary_snapshots
      ORDER BY emitted_at_utc ASC, id ASC
    `)
    .all();
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const byDay = new Map();
  let previous = null;
  for (const row of rows) {
    const emittedAtUtc = typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : null;
    if (!emittedAtUtc) {
      continue;
    }
    const day = emittedAtUtc.slice(0, 10);
    const current = byDay.get(day) || {
      date: day,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      successCount: 0,
      failureCount: 0,
      durationTotalMs: 0,
      durationCount: 0,
    };

    const completedRequestCount = Number(row.completed_request_count) || 0;
    const inputTokensTotal = Number(row.input_tokens_total) || 0;
    const outputTokensTotal = Number(row.output_tokens_total) || 0;
    const thinkingTokensTotal = Number(row.thinking_tokens_total) || 0;
    const requestDurationMsTotal = Number(row.request_duration_ms_total) || 0;

    const deltaRuns = Math.max(0, previous ? completedRequestCount - previous.completedRequestCount : completedRequestCount);
    const deltaInput = Math.max(0, previous ? inputTokensTotal - previous.inputTokensTotal : inputTokensTotal);
    const deltaOutput = Math.max(0, previous ? outputTokensTotal - previous.outputTokensTotal : outputTokensTotal);
    const deltaThinking = Math.max(0, previous ? thinkingTokensTotal - previous.thinkingTokensTotal : thinkingTokensTotal);
    const deltaDuration = Math.max(0, previous ? requestDurationMsTotal - previous.requestDurationMsTotal : requestDurationMsTotal);

    current.runs += deltaRuns;
    current.inputTokens += deltaInput;
    current.outputTokens += deltaOutput;
    current.thinkingTokens += deltaThinking;
    current.durationTotalMs += deltaDuration;
    current.durationCount += deltaRuns;

    byDay.set(day, current);
    previous = {
      completedRequestCount,
      inputTokensTotal,
      outputTokensTotal,
      thinkingTokensTotal,
      requestDurationMsTotal,
    };
  }

  return Array.from(byDay.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((entry) => ({
      date: entry.date,
      runs: entry.runs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}

function buildDashboardDailyMetrics(runtimeRoot, idleSummaryDatabase) {
  const snapshotDays = buildDashboardDailyMetricsFromIdleSnapshots(idleSummaryDatabase);
  if (snapshotDays.length > 0) {
    const runDays = buildDashboardDailyMetricsFromRuns(runtimeRoot);
    const runByDay = new Map(runDays.map((day) => [day.date, day]));
    return snapshotDays.map((day) => {
      const runDay = runByDay.get(day.date);
      if (!runDay) {
        return day;
      }
      return {
        ...day,
        successCount: runDay.successCount,
        failureCount: runDay.failureCount,
      };
    });
  }
  return buildDashboardDailyMetricsFromRuns(runtimeRoot);
}

function normalizeIdleSummarySnapshotRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const snapshot = {
    emittedAtUtc: typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : null,
    completedRequestCount: Number(row.completed_request_count) || 0,
    inputCharactersTotal: Number(row.input_characters_total) || 0,
    outputCharactersTotal: Number(row.output_characters_total) || 0,
    inputTokensTotal: Number(row.input_tokens_total) || 0,
    outputTokensTotal: Number(row.output_tokens_total) || 0,
    thinkingTokensTotal: Number(row.thinking_tokens_total) || 0,
    savedTokens: Number(row.saved_tokens) || 0,
    savedPercent: Number.isFinite(row.saved_percent) ? Number(row.saved_percent) : null,
    compressionRatio: Number.isFinite(row.compression_ratio) ? Number(row.compression_ratio) : null,
    requestDurationMsTotal: Number(row.request_duration_ms_total) || 0,
    avgRequestMs: Number.isFinite(row.avg_request_ms) ? Number(row.avg_request_ms) : null,
    avgTokensPerSecond: Number.isFinite(row.avg_tokens_per_second) ? Number(row.avg_tokens_per_second) : null,
    summaryText: '',
  };
  snapshot.summaryText = buildIdleSummarySnapshotMessage(snapshot);
  return snapshot;
}

function estimateTokenCount(value) {
  const text = String(value || '');
  if (!text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function getChatSessionsRoot(runtimeRoot) {
  return path.join(runtimeRoot, 'chat', 'sessions');
}

function listChatSessionPaths(runtimeRoot) {
  return listFiles(getChatSessionsRoot(runtimeRoot))
    .filter((targetPath) => /^session_.+\.json$/iu.test(path.basename(targetPath)));
}

function readChatSessionFromPath(targetPath) {
  const payload = safeReadJson(targetPath);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (typeof payload.id !== 'string' || !payload.id.trim()) {
    return null;
  }
  if (typeof payload.thinkingEnabled !== 'boolean') {
    payload.thinkingEnabled = true;
  }
  if (payload.mode !== 'plan') {
    payload.mode = 'chat';
  }
  if (typeof payload.planRepoRoot !== 'string' || !payload.planRepoRoot.trim()) {
    payload.planRepoRoot = process.cwd();
  }
  if (!Array.isArray(payload.hiddenToolContexts)) {
    payload.hiddenToolContexts = [];
  } else {
    payload.hiddenToolContexts = payload.hiddenToolContexts
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const content = typeof entry.content === 'string' ? entry.content.trim() : '';
        if (!content) {
          return null;
        }
        const tokenEstimate = Number.isFinite(entry.tokenEstimate) && Number(entry.tokenEstimate) >= 0
          ? Number(entry.tokenEstimate)
          : estimateTokenCount(content);
        return {
          id: typeof entry.id === 'string' && entry.id.trim() ? entry.id : crypto.randomUUID(),
          content,
          tokenEstimate,
          sourceMessageId: typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim()
            ? entry.sourceMessageId
            : null,
          createdAtUtc: typeof entry.createdAtUtc === 'string' && entry.createdAtUtc.trim()
            ? entry.createdAtUtc
            : new Date().toISOString(),
        };
      })
      .filter(Boolean);
  }
  return payload;
}

function readChatSessions(runtimeRoot) {
  return listChatSessionPaths(runtimeRoot)
    .map(readChatSessionFromPath)
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAtUtc || '').localeCompare(String(left.updatedAtUtc || '')));
}

function getChatSessionPath(runtimeRoot, sessionId) {
  return path.join(getChatSessionsRoot(runtimeRoot), `session_${sessionId}.json`);
}

function saveChatSession(runtimeRoot, session) {
  const targetPath = getChatSessionPath(runtimeRoot, session.id);
  saveContentAtomically(targetPath, `${JSON.stringify(session, null, 2)}\n`);
}

function buildContextUsage(session) {
  const contextWindowTokens = Math.max(1, Number(session.contextWindowTokens || 150000));
  const chatUsedTokens = Array.isArray(session.messages)
    ? session.messages.reduce((sum, message) => {
      const inputTokens = Number(message.inputTokensEstimate || 0);
      const outputTokens = Number(message.outputTokensEstimate || 0);
      const thinkingTokens = Number(message.thinkingTokens || 0);
      return sum + inputTokens + outputTokens + thinkingTokens;
    }, 0)
    : 0;
  const toolUsedTokens = Array.isArray(session.hiddenToolContexts)
    ? session.hiddenToolContexts.reduce((sum, entry) => sum + (Number(entry?.tokenEstimate) || 0), 0)
    : 0;
  const totalUsedTokens = chatUsedTokens + toolUsedTokens;
  const remainingTokens = Math.max(contextWindowTokens - totalUsedTokens, 0);
  const warnThresholdTokens = Math.max(5000, Math.ceil(contextWindowTokens * 0.1));
  return {
    contextWindowTokens,
    usedTokens: chatUsedTokens,
    chatUsedTokens,
    toolUsedTokens,
    totalUsedTokens,
    remainingTokens,
    warnThresholdTokens,
    shouldCondense: remainingTokens <= warnThresholdTokens,
  };
}

function appendChatMessages(runtimeRoot, session, content, assistantContent) {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    content,
    inputTokensEstimate: estimateTokenCount(content),
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: now,
    sourceRunId: null,
  });
  const assistantText = typeof assistantContent === 'string' && assistantContent.trim()
    ? assistantContent
    : 'No assistantContent provided.';
  messages.push({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: assistantText,
    inputTokensEstimate: 0,
    outputTokensEstimate: estimateTokenCount(assistantText),
    thinkingTokens: 0,
    createdAtUtc: now,
    sourceRunId: null,
  });
  const updated = {
    ...session,
    updatedAtUtc: now,
    messages,
  };
  saveChatSession(runtimeRoot, updated);
  return updated;
}

function resolveActiveChatModel(config, session) {
  if (typeof session?.model === 'string' && session.model.trim()) {
    return session.model.trim();
  }
  if (typeof config?.Runtime?.Model === 'string' && config.Runtime.Model.trim()) {
    return config.Runtime.Model.trim();
  }
  if (typeof config?.Model === 'string' && config.Model.trim()) {
    return config.Model.trim();
  }
  return DEFAULT_LLAMA_MODEL;
}

function getChatUsageValue(value) {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function getTextContent(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((part) => (part && typeof part === 'object' && (part.type === 'text' || !part.type)) ? String(part.text || '') : '')
    .join('');
}

function getThinkingTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
    ? usage.completion_tokens_details
    : null;
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details
    : null;
  const sources = [completionDetails, outputDetails, usage];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const reasoningTokens = getChatUsageValue(source.reasoning_tokens) ?? 0;
    const thinkingTokens = getChatUsageValue(source.thinking_tokens) ?? 0;
    if (
      Object.prototype.hasOwnProperty.call(source, 'reasoning_tokens')
      || Object.prototype.hasOwnProperty.call(source, 'thinking_tokens')
    ) {
      return reasoningTokens + thinkingTokens;
    }
  }
  return null;
}

function getChoiceText(choice) {
  const content = choice?.message?.content ?? choice?.text ?? '';
  return getTextContent(content).trim();
}

function getChoiceReasoningText(choice) {
  const content = choice?.message?.reasoning_content ?? '';
  return getTextContent(content).trim();
}

function buildChatCompletionRequest(config, session, userContent, options = {}) {
  const model = resolveActiveChatModel(config, session);
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl) {
    throw new Error('llama.cpp base URL is not configured.');
  }
  const runtimeLlama = getCompatRuntimeLlamaCpp(config);
  const priorMessages = Array.isArray(session.messages) ? session.messages : [];
  const hiddenToolContexts = Array.isArray(session.hiddenToolContexts)
    ? session.hiddenToolContexts
      .map((entry) => (entry && typeof entry.content === 'string' ? entry.content.trim() : ''))
      .filter(Boolean)
    : [];
  const hiddenToolContextText = hiddenToolContexts.join('\n\n');
  const messages = [
    { role: 'system', content: 'general, coder friendly assistant' },
    ...(hiddenToolContextText ? [{
      role: 'system',
      content: `Internal tool-call context from prior session steps. Use this as additional evidence only when relevant.\n\n${hiddenToolContextText}`,
    }] : []),
    // Only feed chat-visible message content back into history; never include prior thinking traces.
    ...priorMessages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || ''),
    })),
    { role: 'user', content: userContent },
  ];
  const thinkingEnabled = options.thinkingEnabled !== false;
  return {
    url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
    model,
    body: {
      model,
      messages,
      stream: Boolean(options.stream),
      cache_prompt: true,
      ...(Number.isFinite(runtimeLlama?.Temperature) ? { temperature: Number(runtimeLlama.Temperature) } : {}),
      ...(Number.isFinite(runtimeLlama?.TopP) ? { top_p: Number(runtimeLlama.TopP) } : {}),
      ...(Number.isFinite(runtimeLlama?.MaxTokens) ? { max_tokens: Number(runtimeLlama.MaxTokens) } : {}),
      chat_template_kwargs: {
        enable_thinking: thinkingEnabled,
      },
      extra_body: {
        ...(Number.isFinite(runtimeLlama?.TopK) ? { top_k: Number(runtimeLlama.TopK) } : {}),
        ...(Number.isFinite(runtimeLlama?.MinP) ? { min_p: Number(runtimeLlama.MinP) } : {}),
        ...(Number.isFinite(runtimeLlama?.PresencePenalty) ? { presence_penalty: Number(runtimeLlama.PresencePenalty) } : {}),
        ...(Number.isFinite(runtimeLlama?.RepetitionPenalty) ? { repeat_penalty: Number(runtimeLlama.RepetitionPenalty) } : {}),
        ...(thinkingEnabled ? {} : { reasoning_budget: 0 }),
      },
    },
  };
}

async function generateChatAssistantMessage(config, session, userContent) {
  const request = buildChatCompletionRequest(config, session, userContent, {
    thinkingEnabled: session.thinkingEnabled !== false,
    stream: false,
  });
  const response = await requestJson(request.url, {
    method: 'POST',
    timeoutMs: 600000,
    body: JSON.stringify(request.body),
  });
  if (response.statusCode >= 400) {
    const detail = String(response.rawText || '').trim();
    throw new Error(`llama.cpp chat failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
  }
  const choice = Array.isArray(response.body?.choices) ? response.body.choices[0] : null;
  const assistantContent = getChoiceText(choice);
  const thinkingContent = getChoiceReasoningText(choice);
  if (!assistantContent) {
    throw new Error('llama.cpp chat returned an empty assistant message.');
  }
  const usage = response.body?.usage && typeof response.body.usage === 'object' ? response.body.usage : {};
  return {
    assistantContent,
    thinkingContent,
    usage: {
      promptTokens: getChatUsageValue(usage.prompt_tokens),
      completionTokens: getChatUsageValue(usage.completion_tokens),
      thinkingTokens: getThinkingTokensFromUsage(usage),
    },
  };
}

function appendChatMessagesWithUsage(runtimeRoot, session, content, assistantContent, usage = {}, thinkingContent = '', options = {}) {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  const userTokens = getChatUsageValue(usage.promptTokens) ?? estimateTokenCount(content);
  const outputTokens = getChatUsageValue(usage.completionTokens) ?? estimateTokenCount(assistantContent);
  const thinkingTokens = getChatUsageValue(usage.thinkingTokens) ?? 0;
  const toolContextContents = Array.isArray(options.toolContextContents)
    ? options.toolContextContents
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    : [];
  const hiddenToolContexts = Array.isArray(session.hiddenToolContexts) ? session.hiddenToolContexts.slice() : [];
  messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    content,
    inputTokensEstimate: userTokens,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: now,
    sourceRunId: null,
  });
  const assistantMessageId = crypto.randomUUID();
  const associatedToolTokens = toolContextContents.reduce((sum, value) => sum + estimateTokenCount(value), 0);
  messages.push({
    id: assistantMessageId,
    role: 'assistant',
    content: assistantContent,
    inputTokensEstimate: 0,
    outputTokensEstimate: outputTokens,
    thinkingTokens,
    associatedToolTokens,
    thinkingContent: String(thinkingContent || ''),
    createdAtUtc: now,
    sourceRunId: null,
  });
  for (const value of toolContextContents) {
    hiddenToolContexts.push({
      id: crypto.randomUUID(),
      content: value,
      tokenEstimate: estimateTokenCount(value),
      sourceMessageId: assistantMessageId,
      createdAtUtc: now,
    });
  }
  const updated = {
    ...session,
    updatedAtUtc: now,
    messages,
    hiddenToolContexts,
  };
  saveChatSession(runtimeRoot, updated);
  return updated;
}

async function streamChatAssistantMessage(config, session, userContent, onProgress) {
  const requestConfig = buildChatCompletionRequest(config, session, userContent, {
    thinkingEnabled: session.thinkingEnabled !== false,
    stream: true,
  });
  const target = new URL(requestConfig.url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(requestConfig.body), 'utf8'),
      },
    }, (response) => {
      if ((response.statusCode || 0) >= 400) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          reject(new Error(`llama.cpp chat stream failed with HTTP ${response.statusCode || 0}${body.trim() ? `: ${body.trim()}` : '.'}`));
        });
        return;
      }

      let rawBuffer = '';
      let assistantContent = '';
      let thinkingContent = '';
      let finalUsage = {};
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        rawBuffer += chunk;
        let boundary = rawBuffer.indexOf('\n\n');
        while (boundary >= 0) {
          const packet = rawBuffer.slice(0, boundary);
          rawBuffer = rawBuffer.slice(boundary + 2);
          boundary = rawBuffer.indexOf('\n\n');
          const lines = packet
            .split(/\r?\n/gu)
            .map((line) => line.trim())
            .filter(Boolean);
          const dataLine = lines.find((line) => line.startsWith('data:'));
          if (!dataLine) {
            continue;
          }
          const dataValue = dataLine.slice(5).trim();
          if (dataValue === '[DONE]') {
            continue;
          }
          try {
            const parsed = JSON.parse(dataValue);
            const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
            const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta : {};
            const deltaThinking = getTextContent(delta.reasoning_content);
            const deltaAnswer = getTextContent(delta.content);
            if (deltaThinking) {
              thinkingContent += deltaThinking;
            }
            if (deltaAnswer) {
              assistantContent += deltaAnswer;
            }
            if (parsed?.usage && typeof parsed.usage === 'object') {
              finalUsage = {
                promptTokens: getChatUsageValue(parsed.usage.prompt_tokens),
                completionTokens: getChatUsageValue(parsed.usage.completion_tokens),
                thinkingTokens: getThinkingTokensFromUsage(parsed.usage),
              };
            }
            if (typeof onProgress === 'function') {
              onProgress({
                assistantContent,
                thinkingContent,
              });
            }
          } catch {
            // Ignore malformed stream chunks.
          }
        }
      });
      response.on('end', () => {
        if (!assistantContent.trim()) {
          reject(new Error('llama.cpp chat stream returned an empty assistant message.'));
          return;
        }
        resolve({
          assistantContent: assistantContent.trim(),
          thinkingContent: thinkingContent.trim(),
          usage: finalUsage,
        });
      });
    });
    request.setTimeout(600000, () => {
      request.destroy(new Error('llama.cpp chat stream timed out.'));
    });
    request.on('error', reject);
    request.write(JSON.stringify(requestConfig.body));
    request.end();
  });
}

function condenseChatSession(runtimeRoot, session) {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  const keptCount = Math.min(messages.length, 2);
  const startIndex = Math.max(messages.length - keptCount, 0);
  const sourceMessages = startIndex > 0 ? messages.slice(0, startIndex) : messages;
  const condensedText = sourceMessages
    .map((message) => `${message.role}: ${String(message.content || '')}`)
    .join('\n');
  const condensedTail = condensedText.length > 2400 ? condensedText.slice(condensedText.length - 2400) : condensedText;
  const nextMessages = messages.map((message, index) => ({
    ...message,
    compressedIntoSummary: index < startIndex,
  }));
  const updated = {
    ...session,
    updatedAtUtc: now,
    condensedSummary: condensedTail || session.condensedSummary || '',
    messages: nextMessages,
  };
  saveChatSession(runtimeRoot, updated);
  return updated;
}

function buildPlanRequestPrompt(userPrompt) {
  const task = String(userPrompt || '').trim();
  return [
    'You are creating an implementation plan from repository evidence.',
    'Search thoroughly before finishing.',
    'Required output format (Markdown):',
    '1. Summary of Request and Approach',
    '2. Goal',
    '3. Current State (with explicit file paths)',
    '4. Implementation Plan (numbered steps covering what, where, how, and why)',
    '5. Code Evidence (each bullet must include file path + line numbers + a short code snippet)',
    '6. Critical Review (risks, flaws, better alternatives, edge cases, missing tests)',
    '7. Validation Plan (tests + checks)',
    '8. Open Questions (if any)',
    'Constraints:',
    '- Start with a short "Summary of Request and Approach" describing how you will tackle the request.',
    '- Review for any misalignment between the request and existing repository behavior/architecture; call it out explicitly.',
    '- If the request appears faulty, contradictory, or nonsensical, say so clearly and explain why.',
    '- Add clear open questions at the bottom when clarification is needed to refine the plan.',
    '- The plan should be comprehensive and usable as an implementation blueprint.',
    '- Be critical; call out any concerns clearly.',
    '- Use concrete line references like path/to/file.ts:123.',
    '- Include short code snippets for the referenced lines and explain the reasoning for proposed changes.',
    '- Prefer precise, executable steps over broad advice.',
    '',
    `Task: ${task}`,
  ].join('\n');
}

function truncatePlanEvidence(value, maxLength = 700) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

function buildPlanMarkdownFromRepoSearch(userPrompt, repoRoot, result) {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
  const primaryTask = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
  const modelOutput = typeof primaryTask?.finalOutput === 'string' && primaryTask.finalOutput.trim()
    ? primaryTask.finalOutput.trim()
    : 'No final planner output was produced.';
  const commandEvidence = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
      continue;
    }
    for (const command of task.commands) {
      if (!command || typeof command !== 'object') {
        continue;
      }
      const commandText = typeof command.command === 'string' ? command.command.trim() : '';
      const outputText = truncatePlanEvidence(command.output);
      if (!commandText || !outputText) {
        continue;
      }
      commandEvidence.push({
        command: commandText,
        output: outputText,
      });
      if (commandEvidence.length >= 6) {
        break;
      }
    }
    if (commandEvidence.length >= 6) {
      break;
    }
  }

  const lines = [
    '# Implementation Plan',
    '',
    '## Request',
    userPrompt,
    '',
    '## Target Repo Root',
    `\`${repoRoot}\``,
    '',
    '## Planner Output',
    modelOutput,
    '',
    '## Code Evidence',
  ];
  if (commandEvidence.length === 0) {
    lines.push('- No command evidence was captured.');
  } else {
    for (const entry of commandEvidence) {
      lines.push(`- Command: \`${entry.command}\``);
      lines.push('```text');
      lines.push(entry.output);
      lines.push('```');
    }
  }

  lines.push('', '## Critical Review');
  const missingSignals = Array.isArray(primaryTask?.missingSignals) ? primaryTask.missingSignals : [];
  if (missingSignals.length > 0) {
    lines.push(`- Missing expected evidence signals: ${missingSignals.join(', ')}`);
  } else {
    lines.push('- Verify that proposed changes preserve existing behavior and test coverage.');
  }
  lines.push('- Check for hidden coupling between chat flow state, session persistence, and model-request locking.');
  lines.push('- Validate repo-root input carefully to avoid running searches outside intended workspace.');
  lines.push('', '## Artifacts');
  lines.push(`- Transcript: \`${String(result?.transcriptPath || '')}\``);
  lines.push(`- Artifact: \`${String(result?.artifactPath || '')}\``);
  return lines.join('\n');
}

function truncateToolContextOutput(value, maxLength = 1400) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

function buildToolContextFromRepoSearchResult(result) {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
  const contexts = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
      continue;
    }
    for (const command of task.commands) {
      if (!command || typeof command !== 'object') {
        continue;
      }
      const commandText = typeof command.command === 'string' ? command.command.trim() : '';
      if (!commandText) {
        continue;
      }
      const outputText = truncateToolContextOutput(command.output);
      const exitCode = Number.isFinite(command.exitCode) ? Number(command.exitCode) : null;
      contexts.push([
        `Command: ${commandText}`,
        `Exit Code: ${exitCode === null ? 'n/a' : String(exitCode)}`,
        'Result:',
        outputText || '(empty output)',
      ].join('\n'));
    }
  }
  return contexts;
}

function buildRepoSearchMarkdown(userPrompt, repoRoot, result) {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
  const primaryTask = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
  const modelOutput = typeof primaryTask?.finalOutput === 'string' && primaryTask.finalOutput.trim()
    ? primaryTask.finalOutput.trim()
    : 'No repo-search output was produced.';
  const commandEvidence = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
      continue;
    }
    for (const command of task.commands) {
      if (!command || typeof command !== 'object') {
        continue;
      }
      const commandText = typeof command.command === 'string' ? command.command.trim() : '';
      const outputText = truncatePlanEvidence(command.output);
      if (!commandText || !outputText) {
        continue;
      }
      commandEvidence.push({ command: commandText, output: outputText });
      if (commandEvidence.length >= 10) { break; }
    }
    if (commandEvidence.length >= 10) { break; }
  }

  const lines = [
    '# Repo Search Results',
    '',
    '## Query',
    userPrompt,
    '',
    '## Repo Root',
    `\`${repoRoot}\``,
    '',
    '## Output',
    modelOutput,
    '',
    '## Commands Executed',
  ];
  if (commandEvidence.length === 0) {
    lines.push('- No commands were executed.');
  } else {
    for (const entry of commandEvidence) {
      lines.push(`- \`${entry.command}\``);
      lines.push('```text');
      lines.push(entry.output);
      lines.push('```');
    }
  }
  lines.push('', '## Artifacts');
  lines.push(`- Transcript: \`${String(result?.transcriptPath || '')}\``);
  lines.push(`- Artifact: \`${String(result?.artifactPath || '')}\``);
  return lines.join('\n');
}

function loadRepoSearchExecutor() {
  const modulePath = require.resolve('../dist/repo-search.js');
  delete require.cache[modulePath];
  const loadedModule = require(modulePath);
  if (!loadedModule || typeof loadedModule.executeRepoSearchRequest !== 'function') {
    throw new Error('repo-search module does not export executeRepoSearchRequest.');
  }
  return loadedModule.executeRepoSearchRequest;
}

function startStatusServer(options = {}) {
  const disableManagedLlamaStartup = Boolean(options.disableManagedLlamaStartup);
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
  const activeRunsByRequestId = new Map();
  const activeRequestIdByStatusPath = new Map();
  let activeModelRequest = null;
  let pendingIdleSummaryMetadata = {
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
  };
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
  let resolveStartupPromise;
  let rejectStartupPromise;
  const startupPromise = new Promise((resolve, reject) => {
    resolveStartupPromise = resolve;
    rejectStartupPromise = reject;
  });

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

  function spawnManagedScript(scriptPath, purpose, options = {}) {
    const logPaths = options.logPaths || createManagedLlamaLogPaths(purpose);
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
        SIFTKIT_MANAGED_LLAMA_STARTUP: '1',
        ...(options.syncOnly ? { SIFTKIT_MANAGED_LLAMA_SYNC_ONLY: '1' } : {}),
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

  async function syncManagedLlamaConfigFromStartupScriptIfNeeded() {
    const config = readConfig(configPath);
    if (config.Backend !== 'llama.cpp') {
      return;
    }

    const managed = getManagedLlamaConfig(config);
    if (!managed.StartupScript) {
      return;
    }

    logLine(`llama_sync startup_script script=${managed.StartupScript}`);
    const launched = spawnManagedScript(managed.StartupScript, 'startup-sync', { syncOnly: true });
    managedLlamaLastStartupLogs = launched.logPaths;
    await new Promise((resolve, reject) => {
      launched.child.once('error', reject);
      launched.child.once('exit', (code) => {
        if ((code ?? 0) !== 0) {
          reject(new Error(`Configured llama.cpp startup script exited with code ${code} during config sync.`));
          return;
        }
        resolve();
      });
    });
    logLine(`llama_sync startup_script done script=${managed.StartupScript}`);
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

  async function shutdownManagedLlamaIfNeeded(options = {}) {
    if (disableManagedLlamaStartup) {
      managedLlamaReady = false;
      releaseSiftKitGpuLockIfIdle();
      return;
    }

    const config = readConfig(configPath);
    if (config.Backend !== 'llama.cpp') {
      return;
    }

    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl) {
      return;
    }
    const force = Boolean(options.force);
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : getManagedLlamaConfig(config).StartupTimeoutMs;
    const shutdownDeadline = Date.now() + timeoutMs;

    if (managedLlamaStartupPromise) {
      await managedLlamaStartupPromise;
    }
    if (managedLlamaShutdownPromise) {
      return managedLlamaShutdownPromise;
    }

    const managed = getManagedLlamaConfig(config);
    const hasActiveHostProcess = Boolean(
      managedLlamaHostProcess
      && managedLlamaHostProcess.exitCode === null
      && managedLlamaHostProcess.signalCode === null
    );
    if (!managed.ShutdownScript && !hasActiveHostProcess) {
      managedLlamaReady = false;
      releaseSiftKitGpuLockIfIdle();
      return;
    }
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
      } else if (hasActiveHostProcess) {
        const hostPid = managedLlamaHostProcess?.pid ?? 0;
        logLine(`llama_stop stopping pid=${hostPid}`);
        terminateProcessTree(hostPid);
      } else {
        process.stderr.write('[siftKitStatus] llama.cpp is still reachable but no shutdown script is configured and no managed host process is active.\n');
        return;
      }

      try {
        await waitForLlamaServerReachability(config, false, shutdownDeadline);
      } catch (error) {
        if (force && hasActiveHostProcess) {
          const hostPid = managedLlamaHostProcess?.pid ?? 0;
          terminateProcessTree(hostPid);
          return;
        }
        throw error;
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
      resetPendingIdleSummaryMetadata();
      siftKitWaitingForGpuLock = false;
      siftKitOwnsGpuLock = false;
      if (disableManagedLlamaStartup) {
        publishStatus();
        return;
      }
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
      if (disableManagedLlamaStartup) {
        return;
      }
      await shutdownManagedLlamaIfNeeded({ force: true, timeoutMs: 10000 });
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during server exit: ${error.message}\n`);
    } finally {
      managedLlamaReady = false;
      idleSummaryPending = false;
      resetPendingIdleSummaryMetadata();
      releaseSiftKitGpuLockIfIdle();
    }
  }

  async function clearPreexistingManagedLlamaIfNeeded() {
    if (disableManagedLlamaStartup) {
      return;
    }

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
    return activeRequestIdByStatusPath.has(statusPath);
  }

  function getResolvedRequestId(metadata, currentStatusPath) {
    if (metadata.requestId) {
      return metadata.requestId;
    }

    return `legacy:${currentStatusPath}`;
  }

  function clearRunState(requestId) {
    const runState = activeRunsByRequestId.get(requestId);
    if (!runState) {
      return null;
    }

    activeRunsByRequestId.delete(requestId);
    if (activeRequestIdByStatusPath.get(runState.statusPath) === requestId) {
      activeRequestIdByStatusPath.delete(runState.statusPath);
    }
    return runState;
  }

  function logAbandonedRun(runState, now) {
    logLine(buildStatusRequestLogMessage({
      running: false,
      requestId: runState.requestId,
      terminalState: 'failed',
      errorMessage: 'Abandoned because a new request started before terminal status.',
      rawInputCharacterCount: runState.rawInputCharacterCount,
      promptCharacterCount: runState.promptCharacterCount,
      promptTokenCount: runState.promptTokenCount,
      chunkIndex: runState.chunkIndex,
      chunkTotal: runState.chunkTotal,
      chunkPath: runState.chunkPath,
      totalElapsedMs: now - runState.overallStartedAt,
    }));

    const logsPath = path.join(getRuntimeRoot(), 'logs');
    const abandonedPath = path.join(logsPath, 'abandoned', `request_abandoned_${runState.requestId}.json`);
    try {
      saveContentAtomically(abandonedPath, JSON.stringify({
        requestId: runState.requestId,
        reason: 'Abandoned because a new request started before terminal status.',
        abandonedAtUtc: new Date(now).toISOString(),
        totalElapsedMs: now - runState.overallStartedAt,
        stepCount: runState.stepCount,
        rawInputCharacterCount: runState.rawInputCharacterCount,
        promptCharacterCount: runState.promptCharacterCount,
        promptTokenCount: runState.promptTokenCount,
        outputTokensTotal: runState.outputTokensTotal,
        chunkIndex: runState.chunkIndex,
        chunkTotal: runState.chunkTotal,
        chunkPath: runState.chunkPath,
      }, null, 2) + '\n');
    } catch {
      // Best-effort — don't fail the incoming request.
    }
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

  function writePublishedStatus(publishedStatus = getPublishedStatusText()) {
    writeText(statusPath, disableManagedLlamaStartup ? STATUS_TRUE : publishedStatus);
  }

  function publishStatus() {
    writePublishedStatus();
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

  function resetPendingIdleSummaryMetadata() {
    pendingIdleSummaryMetadata = {
      inputCharactersPerContextToken: null,
      chunkThresholdCharacters: null,
    };
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
      const snapshot = buildIdleSummarySnapshot({
        ...metrics,
        ...pendingIdleSummaryMetadata,
      }, emittedAt);
      try {
        persistIdleSummarySnapshot(getIdleSummaryDatabase(), snapshot);
      } catch (error) {
        process.stderr.write(`[siftKitStatus] Failed to persist idle summary snapshot to ${idleSummarySnapshotsPath}: ${error.message}\n`);
      }
      logLine(buildIdleSummarySnapshotMessage(snapshot), emittedAt);
      idleSummaryPending = false;
      resetPendingIdleSummaryMetadata();
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

  function acquireModelRequest(kind) {
    if (activeModelRequest) {
      return null;
    }
    const lock = {
      token: crypto.randomUUID(),
      kind: String(kind),
      startedAtUtc: new Date().toISOString(),
    };
    activeModelRequest = lock;
    return lock;
  }

  async function acquireModelRequestWithWait(kind) {
    let lock = acquireModelRequest(kind);
    while (!lock) {
      await sleep(25);
      lock = acquireModelRequest(kind);
    }
    return lock;
  }

  function releaseModelRequest(token) {
    if (!activeModelRequest || activeModelRequest.token !== token) {
      return false;
    }
    activeModelRequest = null;
    return true;
  }

  server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const runtimeRoot = getRuntimeRoot();

    if (req.method === 'GET' && pathname === '/dashboard/runs') {
      const query = requestUrl.searchParams;
      const search = (query.get('search') || '').trim().toLowerCase();
      const kind = (query.get('kind') || '').trim().toLowerCase();
      const statusFilter = (query.get('status') || '').trim().toLowerCase();
      const runs = loadDashboardRuns(runtimeRoot).filter((run) => {
        if (kind && String(run.kind).toLowerCase() !== kind) {
          return false;
        }
        if (statusFilter && String(run.status).toLowerCase() !== statusFilter) {
          return false;
        }
        if (!search) {
          return true;
        }
        return String(run.title || '').toLowerCase().includes(search) || String(run.id).toLowerCase().includes(search);
      });
      sendJson(res, 200, { runs, total: runs.length });
      return;
    }

    if (req.method === 'GET' && /^\/dashboard\/runs\/[^/]+$/u.test(pathname)) {
      const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/runs\//u, ''));
      const detail = buildDashboardRunDetail(runtimeRoot, runId);
      if (!detail) {
        sendJson(res, 404, { error: 'Run not found.' });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard/metrics/timeseries') {
      const days = buildDashboardDailyMetrics(
        runtimeRoot,
        fs.existsSync(idleSummarySnapshotsPath) ? getIdleSummaryDatabase() : null
      );
      sendJson(res, 200, { days });
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard/metrics/idle-summary') {
      if (!fs.existsSync(idleSummarySnapshotsPath)) {
        sendJson(res, 200, { latest: null, snapshots: [] });
        return;
      }
      const limitValue = Number(requestUrl.searchParams.get('limit') || 30);
      const limit = Math.max(1, Math.min(200, Number.isFinite(limitValue) ? Math.floor(limitValue) : 30));
      const rows = getIdleSummaryDatabase()
        .prepare(`
          SELECT
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
          FROM idle_summary_snapshots
          ORDER BY id DESC
          LIMIT ?
        `)
        .all(limit);
      const snapshots = rows
        .map(normalizeIdleSummarySnapshotRow)
        .filter(Boolean);
      sendJson(res, 200, { latest: snapshots[0] || null, snapshots });
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard/chat/sessions') {
      sendJson(res, 200, { sessions: readChatSessions(runtimeRoot) });
      return;
    }

    if (req.method === 'GET' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      sendJson(res, 200, { session, contextUsage: buildContextUsage(session) });
      return;
    }

    if (req.method === 'PUT' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
      const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
      const session = readChatSessionFromPath(sessionPath);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      const updated = {
        ...session,
        updatedAtUtc: new Date().toISOString(),
      };
      if (typeof parsedBody.title === 'string' && parsedBody.title.trim()) {
        updated.title = parsedBody.title.trim();
      }
      if (typeof parsedBody.thinkingEnabled === 'boolean') {
        updated.thinkingEnabled = parsedBody.thinkingEnabled;
      }
      if (typeof parsedBody.mode === 'string' && (parsedBody.mode === 'chat' || parsedBody.mode === 'plan' || parsedBody.mode === 'repo-search')) {
        updated.mode = parsedBody.mode;
      }
      if (typeof parsedBody.planRepoRoot === 'string' && parsedBody.planRepoRoot.trim()) {
        updated.planRepoRoot = path.resolve(parsedBody.planRepoRoot.trim());
      }
      saveChatSession(runtimeRoot, updated);
      sendJson(res, 200, { session: updated, contextUsage: buildContextUsage(updated) });
      return;
    }

    if (req.method === 'DELETE' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
      const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
      if (!fs.existsSync(sessionPath)) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      try {
        fs.rmSync(sessionPath, { force: true });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      sendJson(res, 200, { ok: true, deleted: true, id: sessionId });
      return;
    }

    if (req.method === 'POST' && pathname === '/dashboard/chat/sessions') {
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      const now = new Date().toISOString();
      const session = {
        id: crypto.randomUUID(),
        title: typeof parsedBody.title === 'string' && parsedBody.title.trim() ? parsedBody.title.trim() : 'New Session',
        model: typeof parsedBody.model === 'string' && parsedBody.model.trim()
          ? parsedBody.model.trim()
          : readConfig(configPath)?.Runtime?.Model || null,
        contextWindowTokens: Number(readConfig(configPath)?.Runtime?.LlamaCpp?.NumCtx || 150000),
        thinkingEnabled: readConfig(configPath)?.Runtime?.LlamaCpp?.Reasoning !== 'off',
        mode: 'chat',
        planRepoRoot: process.cwd(),
        condensedSummary: '',
        createdAtUtc: now,
        updatedAtUtc: now,
        messages: [],
        hiddenToolContexts: [],
      };
      saveChatSession(runtimeRoot, session);
      sendJson(res, 200, { session, contextUsage: buildContextUsage(session) });
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_chat');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      try {
        const userContent = parsedBody.content.trim();
        let assistantContent;
        let usage;
        let thinkingContent = '';
        if (typeof parsedBody.assistantContent === 'string' && parsedBody.assistantContent.trim()) {
          assistantContent = parsedBody.assistantContent.trim();
          usage = {};
        } else {
          const config = readConfig(configPath);
          const generated = await generateChatAssistantMessage(config, session, userContent);
          assistantContent = generated.assistantContent;
          usage = generated.usage;
          thinkingContent = generated.thinkingContent || '';
        }
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          session,
          userContent,
          assistantContent,
          usage,
          thinkingContent
        );
        sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_plan');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim()
        ? parsedBody.repoRoot.trim()
        : (typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim() ? session.planRepoRoot.trim() : process.cwd());
      const resolvedRepoRoot = path.resolve(requestedRepoRoot);
      if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
        return;
      }

      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const result = await executeRepoSearchRequest({
          prompt: buildPlanRequestPrompt(parsedBody.content.trim()),
          repoRoot: resolvedRepoRoot,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && parsedBody.model.trim() ? parsedBody.model.trim() : undefined,
          requestMaxTokens: 10000,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim() ? parsedBody.logFile.trim() : undefined,
          availableModels: Array.isArray(parsedBody.availableModels)
            ? parsedBody.availableModels.map((value) => String(value))
            : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses)
            ? parsedBody.mockResponses.map((value) => String(value))
            : undefined,
          mockCommandResults: (
            parsedBody.mockCommandResults
            && typeof parsedBody.mockCommandResults === 'object'
            && !Array.isArray(parsedBody.mockCommandResults)
          ) ? parsedBody.mockCommandResults : undefined,
        });
        const assistantContent = buildPlanMarkdownFromRepoSearch(parsedBody.content.trim(), resolvedRepoRoot, result);
        const toolContextContents = buildToolContextFromRepoSearchResult(result);
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          {
            ...session,
            mode: 'plan',
            planRepoRoot: resolvedRepoRoot,
          },
          parsedBody.content.trim(),
          assistantContent,
          {},
          '',
          {
            toolContextContents,
          }
        );
        sendJson(res, 200, {
          session: updatedSession,
          contextUsage: buildContextUsage(updatedSession),
          repoSearch: {
            requestId: result.requestId,
            transcriptPath: result.transcriptPath,
            artifactPath: result.artifactPath,
            scorecard: result.scorecard,
          },
        });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan\/stream$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_plan_stream');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan\/stream$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim()
        ? parsedBody.repoRoot.trim()
        : (typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim() ? session.planRepoRoot.trim() : process.cwd());
      const resolvedRepoRoot = path.resolve(requestedRepoRoot);
      if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
        return;
      }

      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; });

      const writeSse = (eventName, payload) => {
        if (clientDisconnected) return;
        try {
          res.write(`event: ${eventName}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch { /* client gone */ }
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');

      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const result = await executeRepoSearchRequest({
          prompt: buildPlanRequestPrompt(parsedBody.content.trim()),
          repoRoot: resolvedRepoRoot,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && parsedBody.model.trim() ? parsedBody.model.trim() : undefined,
          requestMaxTokens: 10000,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim() ? parsedBody.logFile.trim() : undefined,
          availableModels: Array.isArray(parsedBody.availableModels)
            ? parsedBody.availableModels.map((value) => String(value))
            : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses)
            ? parsedBody.mockResponses.map((value) => String(value))
            : undefined,
          mockCommandResults: (
            parsedBody.mockCommandResults
            && typeof parsedBody.mockCommandResults === 'object'
            && !Array.isArray(parsedBody.mockCommandResults)
          ) ? parsedBody.mockCommandResults : undefined,
          onProgress(event) {
            if (event.kind === 'thinking') {
              writeSse('thinking', { thinking: event.thinkingText || '' });
            } else if (event.kind === 'tool_start') {
              writeSse('tool_start', { turn: event.turn, maxTurns: event.maxTurns, command: event.command });
            } else if (event.kind === 'tool_result') {
              writeSse('tool_result', { turn: event.turn, maxTurns: event.maxTurns, command: event.command, exitCode: event.exitCode, outputSnippet: event.outputSnippet });
            }
          },
        });
        const assistantContent = buildPlanMarkdownFromRepoSearch(parsedBody.content.trim(), resolvedRepoRoot, result);
        const toolContextContents = buildToolContextFromRepoSearchResult(result);
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          {
            ...session,
            mode: 'plan',
            planRepoRoot: resolvedRepoRoot,
          },
          parsedBody.content.trim(),
          assistantContent,
          {},
          '',
          {
            toolContextContents,
          }
        );
        writeSse('done', {
          session: updatedSession,
          contextUsage: buildContextUsage(updatedSession),
          repoSearch: {
            requestId: result.requestId,
            transcriptPath: result.transcriptPath,
            artifactPath: result.artifactPath,
            scorecard: result.scorecard,
          },
        });
      } catch (error) {
        writeSse('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/repo-search\/stream$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_repo_search_stream');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/stream$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim()
        ? parsedBody.repoRoot.trim()
        : (typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim() ? session.planRepoRoot.trim() : process.cwd());
      const resolvedRepoRoot = path.resolve(requestedRepoRoot);
      if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
        return;
      }

      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; });

      const writeSse = (eventName, payload) => {
        if (clientDisconnected) return;
        try {
          res.write(`event: ${eventName}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch { /* client gone */ }
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');

      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const result = await executeRepoSearchRequest({
          prompt: parsedBody.content.trim(),
          repoRoot: resolvedRepoRoot,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && parsedBody.model.trim() ? parsedBody.model.trim() : undefined,
          requestMaxTokens: 10000,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim() ? parsedBody.logFile.trim() : undefined,
          availableModels: Array.isArray(parsedBody.availableModels)
            ? parsedBody.availableModels.map((value) => String(value))
            : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses)
            ? parsedBody.mockResponses.map((value) => String(value))
            : undefined,
          mockCommandResults: (
            parsedBody.mockCommandResults
            && typeof parsedBody.mockCommandResults === 'object'
            && !Array.isArray(parsedBody.mockCommandResults)
          ) ? parsedBody.mockCommandResults : undefined,
          onProgress(event) {
            if (event.kind === 'thinking') {
              writeSse('thinking', { thinking: event.thinkingText || '' });
            } else if (event.kind === 'tool_start') {
              writeSse('tool_start', { turn: event.turn, maxTurns: event.maxTurns, command: event.command });
            } else if (event.kind === 'tool_result') {
              writeSse('tool_result', { turn: event.turn, maxTurns: event.maxTurns, command: event.command, exitCode: event.exitCode, outputSnippet: event.outputSnippet });
            }
          },
        });
        const assistantContent = buildRepoSearchMarkdown(parsedBody.content.trim(), resolvedRepoRoot, result);
        const toolContextContents = buildToolContextFromRepoSearchResult(result);
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          {
            ...session,
            mode: 'repo-search',
            planRepoRoot: resolvedRepoRoot,
          },
          parsedBody.content.trim(),
          assistantContent,
          {},
          '',
          {
            toolContextContents,
          }
        );
        writeSse('done', {
          session: updatedSession,
          contextUsage: buildContextUsage(updatedSession),
          repoSearch: {
            requestId: result.requestId,
            transcriptPath: result.transcriptPath,
            artifactPath: result.artifactPath,
            scorecard: result.scorecard,
          },
        });
      } catch (error) {
        writeSse('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/tool-context\/clear$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/tool-context\/clear$/u, ''));
      const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
      const session = readChatSessionFromPath(sessionPath);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      const updatedSession = {
        ...session,
        updatedAtUtc: new Date().toISOString(),
        hiddenToolContexts: [],
      };
      saveChatSession(runtimeRoot, updatedSession);
      sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages\/stream$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_chat');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages\/stream$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }

      const writeSse = (eventName, payload) => {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');

      try {
        const userContent = parsedBody.content.trim();
        const config = readConfig(configPath);
        const generated = await streamChatAssistantMessage(config, session, userContent, (progress) => {
          writeSse('thinking', { thinking: progress.thinkingContent });
          writeSse('answer', { answer: progress.assistantContent });
        });
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          session,
          userContent,
          generated.assistantContent,
          generated.usage,
          generated.thinkingContent
        );
        writeSse('done', { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      } catch (error) {
        writeSse('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/condense$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/condense$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      const updatedSession = condenseChatSession(runtimeRoot, session);
      sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        disableManagedLlamaStartup,
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

    if (req.method === 'POST' && req.url === '/repo-search') {
      const modelRequestLock = await acquireModelRequestWithWait('repo_search');
      let parsedBody;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }

      if (typeof parsedBody.prompt !== 'string' || !parsedBody.prompt.trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected prompt.' });
        return;
      }
      if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
        await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
      }

      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const result = await executeRepoSearchRequest({
          prompt: parsedBody.prompt,
          repoRoot: typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim()
            ? parsedBody.repoRoot.trim()
            : process.cwd(),
          statusBackendUrl: `${getServiceBaseUrl()}/status`,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && parsedBody.model.trim()
            ? parsedBody.model.trim()
            : undefined,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim()
            ? parsedBody.logFile.trim()
            : undefined,
          availableModels: Array.isArray(parsedBody.availableModels)
            ? parsedBody.availableModels.map((value) => String(value))
            : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses)
            ? parsedBody.mockResponses.map((value) => String(value))
            : undefined,
          mockCommandResults: (
            parsedBody.mockCommandResults
            && typeof parsedBody.mockCommandResults === 'object'
            && !Array.isArray(parsedBody.mockCommandResults)
          ) ? parsedBody.mockCommandResults : undefined,
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
      }
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
      if (metadata.artifactType !== null) {
        if (!metadata.artifactRequestId) {
          sendJson(res, 400, { error: 'Expected artifactRequestId when artifactType is provided.' });
          return;
        }
        if (!metadata.artifactPayload) {
          sendJson(res, 400, { error: 'Expected artifactPayload object when artifactType is provided.' });
          return;
        }
        const artifactPath = getStatusArtifactPath(metadata);
        if (!artifactPath) {
          sendJson(res, 400, { error: 'Unsupported artifactType.' });
          return;
        }
        try {
          saveContentAtomically(artifactPath, `${JSON.stringify(metadata.artifactPayload, null, 2)}\n`);
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      const isArtifactOnlyPost = metadata.artifactType !== null
        && metadata.terminalState === null
        && metadata.errorMessage === null
        && metadata.promptCharacterCount === null
        && metadata.promptTokenCount === null
        && metadata.rawInputCharacterCount === null
        && metadata.chunkInputCharacterCount === null
        && metadata.chunkIndex === null
        && metadata.chunkTotal === null
        && metadata.chunkPath === null
        && metadata.inputTokens === null
        && metadata.outputCharacterCount === null
        && metadata.outputTokens === null
        && metadata.thinkingTokens === null
        && metadata.requestDurationMs === null;
      if (isArtifactOnlyPost) {
        const publishedStatus = getPublishedStatusText();
        sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
        return;
      }
      const requestId = getResolvedRequestId(metadata, statusPath);
      let elapsedMs = null;
      let totalElapsedMs = null;
      let requestCompleted = false;
      let suppressLogLine = false;
      let runState = activeRunsByRequestId.get(requestId) || null;
      if (running) {
        clearIdleSummaryTimer();
        const now = Date.now();
        const activeRequestId = activeRequestIdByStatusPath.get(statusPath) || null;
        const activeRun = activeRequestId ? activeRunsByRequestId.get(activeRequestId) : null;
        const needsGpuLock = !activeRun;
        if (metadata.inputCharactersPerContextToken !== null) {
          pendingIdleSummaryMetadata.inputCharactersPerContextToken = metadata.inputCharactersPerContextToken;
        }
        if (metadata.chunkThresholdCharacters !== null) {
          pendingIdleSummaryMetadata.chunkThresholdCharacters = metadata.chunkThresholdCharacters;
        }
        if (activeRun && activeRequestId !== requestId) {
          logAbandonedRun(activeRun, now);
          clearRunState(activeRequestId);
        }
        runState = activeRunsByRequestId.get(requestId) || null;
        if (!runState) {
          runState = {
            requestId,
            statusPath,
            overallStartedAt: now,
            currentRequestStartedAt: now,
            stepCount: 1,
            rawInputCharacterCount: metadata.rawInputCharacterCount,
            promptCharacterCount: metadata.promptCharacterCount,
            promptTokenCount: metadata.promptTokenCount,
            outputTokensTotal: 0,
            chunkIndex: metadata.chunkIndex,
            chunkTotal: metadata.chunkTotal,
            chunkPath: metadata.chunkPath,
          };
        } else {
          runState.currentRequestStartedAt = now;
          runState.stepCount = Number.isFinite(runState.stepCount) ? runState.stepCount + 1 : 1;
          if (runState.rawInputCharacterCount === null && metadata.rawInputCharacterCount !== null) {
            runState.rawInputCharacterCount = metadata.rawInputCharacterCount;
          }
          if (metadata.promptCharacterCount !== null) {
            runState.promptCharacterCount = metadata.promptCharacterCount;
          }
          if (metadata.promptTokenCount !== null) {
            runState.promptTokenCount = metadata.promptTokenCount;
          }
          if (metadata.chunkIndex !== null) {
            runState.chunkIndex = metadata.chunkIndex;
          }
          if (metadata.chunkTotal !== null) {
            runState.chunkTotal = metadata.chunkTotal;
          }
          if (metadata.chunkPath !== null) {
            runState.chunkPath = metadata.chunkPath;
          }
        }

        activeRunsByRequestId.set(requestId, runState);
        activeRequestIdByStatusPath.set(statusPath, requestId);
        if (needsGpuLock) {
          await ensureSiftKitGpuLockAcquired();
        }
      } else {
        if (runState && Number.isFinite(runState.currentRequestStartedAt)) {
          const now = Date.now();
          const resolvedOutputTokens = metadata.outputTokens ?? 0;
          const isSingleStepNonChunk = runState.stepCount === 1
            && runState.chunkIndex === null
            && runState.chunkTotal === null
            && runState.chunkPath === null;
          suppressLogLine = metadata.terminalState === null && isSingleStepNonChunk;
          elapsedMs = now - runState.currentRequestStartedAt;
          runState.outputTokensTotal += resolvedOutputTokens;
          if (metadata.rawInputCharacterCount === null && runState.rawInputCharacterCount !== null) {
            metadata.rawInputCharacterCount = runState.rawInputCharacterCount;
          }
          if (metadata.promptCharacterCount === null && runState.promptCharacterCount !== null) {
            metadata.promptCharacterCount = runState.promptCharacterCount;
          }
          if (metadata.promptTokenCount === null && runState.promptTokenCount !== null) {
            metadata.promptTokenCount = runState.promptTokenCount;
          }
          if (metadata.chunkIndex === null && runState.chunkIndex !== null) {
            metadata.chunkIndex = runState.chunkIndex;
          }
          if (metadata.chunkTotal === null && runState.chunkTotal !== null) {
            metadata.chunkTotal = runState.chunkTotal;
          }
          if (metadata.chunkPath === null && runState.chunkPath !== null) {
            metadata.chunkPath = runState.chunkPath;
          }
          if (metadata.terminalState === 'completed') {
            totalElapsedMs = now - runState.overallStartedAt;
            metadata.totalOutputTokens = runState.outputTokensTotal;
            clearRunState(requestId);
            requestCompleted = true;
          } else if (metadata.terminalState === 'failed') {
            totalElapsedMs = now - runState.overallStartedAt;
            clearRunState(requestId);
          }
        }
        metrics = normalizeMetrics({
          ...metrics,
          inputCharactersTotal: metrics.inputCharactersTotal + (metadata.promptCharacterCount ?? 0),
          outputCharactersTotal: metrics.outputCharactersTotal + (metadata.outputCharacterCount ?? 0),
          inputTokensTotal: metrics.inputTokensTotal + (metadata.inputTokens ?? 0),
          outputTokensTotal: metrics.outputTokensTotal + (metadata.outputTokens ?? 0),
          thinkingTokensTotal: metrics.thinkingTokensTotal + (metadata.thinkingTokens ?? 0),
          requestDurationMsTotal: metrics.requestDurationMsTotal + (
            metadata.requestDurationMs
            ?? (metadata.terminalState ? 0 : (elapsedMs ?? 0))
          ),
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
        requestId,
        terminalState: metadata.terminalState,
        errorMessage: metadata.errorMessage,
        promptCharacterCount: metadata.promptCharacterCount,
        promptTokenCount: metadata.promptTokenCount,
        rawInputCharacterCount: metadata.rawInputCharacterCount,
        chunkInputCharacterCount: metadata.chunkInputCharacterCount,
        budgetSource: metadata.budgetSource,
        inputCharactersPerContextToken: metadata.inputCharactersPerContextToken,
        chunkThresholdCharacters: metadata.chunkThresholdCharacters,
        chunkIndex: metadata.chunkIndex,
        chunkTotal: metadata.chunkTotal,
        chunkPath: metadata.chunkPath,
        elapsedMs,
        totalElapsedMs,
        outputTokens: metadata.outputTokens,
        totalOutputTokens: metadata.totalOutputTokens ?? null
      });
      if (!suppressLogLine) {
        logLine(logMessage);
      }
      const publishedStatus = getPublishedStatusText();
      writePublishedStatus(publishedStatus);
      sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      try {
        if (disableManagedLlamaStartup) {
          sendJson(res, 200, readConfig(configPath));
          return;
        }
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
      if (!disableManagedLlamaStartup) {
        await syncManagedLlamaConfigFromStartupScriptIfNeeded();
        await clearPreexistingManagedLlamaIfNeeded();
        bootstrapManagedLlamaStartup = true;
        try {
          await ensureManagedLlamaReady({ resetStatusBeforeCheck: false });
        } finally {
          bootstrapManagedLlamaStartup = false;
        }
      }
      publishStatus();
      const address = server.address();
      process.stdout.write(`${JSON.stringify({ ok: true, port: address.port, host, statusPath, configPath })}\n`);
      resolveStartupPromise();
    } catch (error) {
      rejectStartupPromise(error);
      dumpManagedLlamaStartupReviewToConsole(managedLlamaLastStartupLogs);
      process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${error.message}\n`);
      server.close(() => process.exit(1));
    }
  });
  server.on('close', () => {
    clearIdleSummaryTimer();
    if (idleSummaryDatabase) {
      idleSummaryDatabase.close();
      idleSummaryDatabase = null;
    }
  });
  server.shutdownManagedLlamaForServerExit = shutdownManagedLlamaForServerExit;
  server.shutdownManagedLlamaForProcessExitSync = shutdownManagedLlamaForProcessExitSync;
  server.startupPromise = startupPromise;

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
  terminateProcessTree,
  supportsAnsiColor,
  startStatusServer
};

if (require.main === module) {
  const server = startStatusServer({
    disableManagedLlamaStartup: process.argv.includes('--disable-managed-llama-startup'),
  });
  let shuttingDown = false;
  let forcedExitTimer = null;
  const shutdown = async (signal = 'SIGTERM') => {
    if (shuttingDown) {
      process.stderr.write('[siftKitStatus] Shutdown already in progress; forcing immediate exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
      return;
    }
    shuttingDown = true;
    forcedExitTimer = setTimeout(() => {
      process.stderr.write('[siftKitStatus] Graceful shutdown timed out; forcing process exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
    }, 15000);
    if (typeof forcedExitTimer.unref === 'function') {
      forcedExitTimer.unref();
    }
    try {
      if (typeof server.shutdownManagedLlamaForServerExit === 'function') {
        await server.shutdownManagedLlamaForServerExit();
      }
    } finally {
      if (forcedExitTimer) {
        clearTimeout(forcedExitTimer);
        forcedExitTimer = null;
      }
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
