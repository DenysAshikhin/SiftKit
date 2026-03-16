const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const STATUS_IDLE_CLEAR_INTERVAL_MS = 10_000;
const EXECUTION_LEASE_STALE_MS = 10_000;
const IDLE_SUMMARY_DELAY_MS = getPositiveIntegerFromEnv('SIFTKIT_IDLE_SUMMARY_DELAY_MS', 60_000);

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

function ensureStatusFile(targetPath) {
  if (!fs.existsSync(targetPath)) {
    writeText(targetPath, 'false');
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
    Model: 'qwen3.5-9b-instruct-q4_k_m',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080',
      NumCtx: 128000,
      ModelPath: null,
      Temperature: 0.2,
      TopP: 0.95,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 0.0,
      RepetitionPenalty: 1.0,
      MaxTokens: 4096,
      GpuLayers: 999,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off'
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
  if (merged.Ollama && !merged.LlamaCpp) {
    merged.LlamaCpp = {
      BaseUrl: merged.Ollama.BaseUrl || getDefaultConfig().LlamaCpp.BaseUrl,
      NumCtx: Number(merged.Ollama.NumCtx || getDefaultConfig().LlamaCpp.NumCtx),
      ModelPath: getDefaultConfig().LlamaCpp.ModelPath,
      Temperature: Number(merged.Ollama.Temperature ?? getDefaultConfig().LlamaCpp.Temperature),
      TopP: Number(merged.Ollama.TopP ?? getDefaultConfig().LlamaCpp.TopP),
      TopK: Number(merged.Ollama.TopK ?? getDefaultConfig().LlamaCpp.TopK),
      MinP: Number(merged.Ollama.MinP ?? getDefaultConfig().LlamaCpp.MinP),
      PresencePenalty: Number(merged.Ollama.PresencePenalty ?? getDefaultConfig().LlamaCpp.PresencePenalty),
      RepetitionPenalty: Number(merged.Ollama.RepetitionPenalty ?? getDefaultConfig().LlamaCpp.RepetitionPenalty),
      ...(Object.prototype.hasOwnProperty.call(merged.Ollama, 'NumPredict') ? { MaxTokens: merged.Ollama.NumPredict } : {}),
      GpuLayers: getDefaultConfig().LlamaCpp.GpuLayers,
      FlashAttention: getDefaultConfig().LlamaCpp.FlashAttention,
      ParallelSlots: getDefaultConfig().LlamaCpp.ParallelSlots,
      Reasoning: getDefaultConfig().LlamaCpp.Reasoning
    };
  }
  delete merged.Ollama;
  delete merged.Paths;
  if (merged.Thresholds && typeof merged.Thresholds === 'object') {
    delete merged.Thresholds.MaxInputCharacters;
  }
  if (merged.LlamaCpp && typeof merged.LlamaCpp === 'object') {
    delete merged.LlamaCpp.Threads;
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
    return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
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
    formatIdleSummarySection('timing', `total=${formatElapsed(snapshot.requestDurationMsTotal)} avg_request=${formatMilliseconds(snapshot.avgRequestMs)} avg_tokens_per_s=${formatTokensPerSecond(snapshot.avgTokensPerSecond)}`, 34, colorOptions)
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
      logMessage += ` raw_chars=${rawInputCharacterCount}`;
    }
    if (chunkInputCharacterCount !== null) {
      logMessage += ` chunk_input_chars=${chunkInputCharacterCount}`;
    }
    if (resolvedPromptCharacterCount !== null) {
      logMessage += ` prompt_chars=${resolvedPromptCharacterCount}`;
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
      return parsed.status.trim().toLowerCase() === 'true';
    }
  } catch {
    const normalized = bodyText.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'false') {
      return normalized === 'true';
    }
  }

  return null;
}

function parseStatusMetadata(bodyText) {
  const metadata = {
    promptCharacterCount: null,
    rawInputCharacterCount: null,
    chunkInputCharacterCount: null,
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

function readStatusText(targetPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8').trim() || 'false';
  } catch {
    return 'false';
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
    idleSummaryTimer = setTimeout(() => {
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
    if (activeRunsByStatusPath.has(statusPath)) {
      return;
    }

    getActiveExecutionLease();

    if (readStatusText(statusPath) === 'true') {
      writeText(statusPath, 'false');
    }
  }, STATUS_IDLE_CLEAR_INTERVAL_MS);
  if (typeof idleStatusWatchdog.unref === 'function') {
    idleStatusWatchdog.unref();
  }

  const server = http.createServer(async (req, res) => {
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
      const currentStatus = readStatusText(statusPath);
      sendJson(res, 200, { running: currentStatus === 'true', status: currentStatus, statusPath, configPath, metrics, idleSummarySnapshotsPath });
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

      const statusText = running ? 'true' : 'false';
      const metadata = parseStatusMetadata(bodyText);
      let elapsedMs = null;
      let totalElapsedMs = null;
      let requestCompleted = false;
      if (running) {
        clearIdleSummaryTimer();
        const now = Date.now();
        const existingRun = activeRunsByStatusPath.get(statusPath);
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
        chunkIndex: metadata.chunkIndex,
        chunkTotal: metadata.chunkTotal,
        elapsedMs,
        totalElapsedMs
      });
      logLine(logMessage);
      writeText(statusPath, statusText);
      sendJson(res, 200, { ok: true, running, status: statusText, statusPath, configPath });
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      sendJson(res, 200, readConfig(configPath));
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

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, () => {
    const address = server.address();
    process.stdout.write(`${JSON.stringify({ ok: true, port: address.port, host, statusPath, configPath })}\n`);
  });
  server.on('close', () => {
    clearInterval(idleStatusWatchdog);
    clearIdleSummaryTimer();
    if (idleSummaryDatabase) {
      idleSummaryDatabase.close();
      idleSummaryDatabase = null;
    }
  });

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
  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
