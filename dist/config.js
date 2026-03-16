"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MissingObservedBudgetError = exports.StatusServerUnavailableError = exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = exports.SIFT_PREVIOUS_DEFAULT_MODEL = exports.SIFT_PREVIOUS_DEFAULT_NUM_CTX = exports.SIFT_LEGACY_DERIVED_NUM_CTX = exports.SIFT_LEGACY_DEFAULT_NUM_CTX = exports.SIFT_DEFAULT_NUM_CTX = exports.SIFTKIT_VERSION = void 0;
exports.ensureDirectory = ensureDirectory;
exports.saveContentAtomically = saveContentAtomically;
exports.getRuntimeRoot = getRuntimeRoot;
exports.initializeRuntime = initializeRuntime;
exports.getDefaultNumCtx = getDefaultNumCtx;
exports.getDerivedMaxInputCharacters = getDerivedMaxInputCharacters;
exports.getEffectiveInputCharactersPerContextToken = getEffectiveInputCharactersPerContextToken;
exports.getEffectiveMaxInputCharacters = getEffectiveMaxInputCharacters;
exports.getChunkThresholdCharacters = getChunkThresholdCharacters;
exports.getInferenceStatusPath = getInferenceStatusPath;
exports.getStatusBackendUrl = getStatusBackendUrl;
exports.getExecutionServiceUrl = getExecutionServiceUrl;
exports.getStatusServerHealthUrl = getStatusServerHealthUrl;
exports.getStatusServerUnavailableMessage = getStatusServerUnavailableMessage;
exports.getExecutionServerState = getExecutionServerState;
exports.tryAcquireExecutionLease = tryAcquireExecutionLease;
exports.refreshExecutionLease = refreshExecutionLease;
exports.releaseExecutionLease = releaseExecutionLease;
exports.ensureStatusServerReachable = ensureStatusServerReachable;
exports.notifyStatusBackend = notifyStatusBackend;
exports.getConfigServiceUrl = getConfigServiceUrl;
exports.getConfigPath = getConfigPath;
exports.saveConfig = saveConfig;
exports.loadConfig = loadConfig;
exports.setTopLevelConfigKey = setTopLevelConfigKey;
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
exports.SIFTKIT_VERSION = '0.1.0';
exports.SIFT_DEFAULT_NUM_CTX = 128_000;
exports.SIFT_LEGACY_DEFAULT_NUM_CTX = 16_384;
exports.SIFT_LEGACY_DERIVED_NUM_CTX = 32_000;
exports.SIFT_PREVIOUS_DEFAULT_NUM_CTX = 50_000;
exports.SIFT_PREVIOUS_DEFAULT_MODEL = 'qwen3.5-4b-q8_0';
exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = 32_000;
exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = 2.5;
function parseJsonText(text) {
    const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return JSON.parse(normalized);
}
function requestJson(options) {
    return new Promise((resolve, reject) => {
        const target = new URL(options.url);
        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: options.method,
            headers: options.body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(options.body, 'utf8'),
            } : undefined,
        }, (response) => {
            let responseText = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                responseText += chunk;
            });
            response.on('end', () => {
                if ((response.statusCode || 0) >= 400) {
                    reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
                    return;
                }
                if (!responseText.trim()) {
                    resolve({});
                    return;
                }
                try {
                    resolve(parseJsonText(responseText));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
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
class StatusServerUnavailableError extends Error {
    healthUrl;
    constructor(healthUrl) {
        super(`SiftKit status/config server is not reachable at ${healthUrl}. Start the separate server process and stop issuing further siftkit commands until it is available.`);
        this.name = 'StatusServerUnavailableError';
        this.healthUrl = healthUrl;
    }
}
exports.StatusServerUnavailableError = StatusServerUnavailableError;
class MissingObservedBudgetError extends Error {
    constructor() {
        super('SiftKit status server did not provide usable input character/token totals. Refusing to derive chunk budgets from the hardcoded fallback; run at least one successful request or fix status metrics first.');
        this.name = 'MissingObservedBudgetError';
    }
}
exports.MissingObservedBudgetError = MissingObservedBudgetError;
function deriveServiceUrl(configuredUrl, nextPath) {
    const target = new URL(configuredUrl);
    target.pathname = nextPath;
    target.search = '';
    target.hash = '';
    return target.toString();
}
function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}
function writeUtf8NoBom(filePath, content) {
    fs.writeFileSync(filePath, content, { encoding: 'utf8' });
}
function saveContentAtomically(filePath, content) {
    const directory = path.dirname(filePath);
    ensureDirectory(directory);
    const tempPath = path.join(directory, `${Math.random().toString(16).slice(2)}.tmp`);
    writeUtf8NoBom(tempPath, content);
    fs.renameSync(tempPath, filePath);
}
function isRuntimeRootWritable(candidate) {
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
    }
    catch {
        return false;
    }
}
function getRuntimeRoot() {
    const configuredStatusPath = process.env.sift_kit_status;
    if (configuredStatusPath && configuredStatusPath.trim()) {
        const absoluteStatusPath = path.resolve(configuredStatusPath);
        const statusDirectory = path.dirname(absoluteStatusPath);
        if (path.basename(statusDirectory).toLowerCase() === 'status') {
            return path.resolve(path.dirname(statusDirectory));
        }
        return path.resolve(statusDirectory);
    }
    const candidates = [];
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
function initializeRuntime() {
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
function getDefaultNumCtx() {
    return exports.SIFT_DEFAULT_NUM_CTX;
}
function getDerivedMaxInputCharacters(numCtx, inputCharactersPerContextToken = exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN) {
    const effectiveNumCtx = numCtx > 0 ? numCtx : getDefaultNumCtx();
    const effectiveCharactersPerContextToken = inputCharactersPerContextToken > 0
        ? inputCharactersPerContextToken
        : exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
    return Math.max(Math.floor(effectiveNumCtx * effectiveCharactersPerContextToken), 1);
}
function getEffectiveInputCharactersPerContextToken(config) {
    const effectiveValue = Number(config.Effective?.InputCharactersPerContextToken);
    return effectiveValue > 0 ? effectiveValue : exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
}
function getEffectiveMaxInputCharacters(config) {
    return getDerivedMaxInputCharacters(Number(config.LlamaCpp.NumCtx), getEffectiveInputCharactersPerContextToken(config));
}
function getChunkThresholdCharacters(config) {
    const ratio = Number(config.Thresholds.ChunkThresholdRatio);
    const effectiveRatio = ratio > 0 && ratio <= 1 ? ratio : 0.92;
    return Math.max(Math.floor(getEffectiveMaxInputCharacters(config) * effectiveRatio), 1);
}
function getInferenceStatusPath() {
    const configuredPath = process.env.sift_kit_status;
    if (configuredPath && configuredPath.trim()) {
        return path.resolve(configuredPath);
    }
    return path.resolve(getRuntimeRoot(), 'status', 'inference.txt');
}
function getStatusBackendUrl() {
    const configuredUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
    if (configuredUrl && configuredUrl.trim()) {
        return configuredUrl.trim();
    }
    const host = process.env.SIFTKIT_STATUS_HOST?.trim() || '127.0.0.1';
    const port = process.env.SIFTKIT_STATUS_PORT?.trim() || '4765';
    return `http://${host}:${port}/status`;
}
async function getStatusSnapshot() {
    try {
        return await requestJson({
            url: getStatusBackendUrl(),
            method: 'GET',
            timeoutMs: 2000,
        });
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
function getObservedInputCharactersPerContextToken(snapshot) {
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
async function resolveInputCharactersPerContextToken() {
    try {
        const snapshot = await getStatusSnapshot();
        const observedValue = getObservedInputCharactersPerContextToken(snapshot);
        if (observedValue !== null) {
            return {
                value: observedValue,
                budgetSource: 'ObservedCharsPerToken',
            };
        }
        throw new MissingObservedBudgetError();
    }
    catch {
        throw new MissingObservedBudgetError();
    }
}
function getExecutionServiceUrl() {
    return deriveServiceUrl(getStatusBackendUrl(), '/execution');
}
function getStatusServerHealthUrl() {
    const configuredConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
    if (configuredConfigUrl && configuredConfigUrl.trim()) {
        return deriveServiceUrl(configuredConfigUrl.trim(), '/health');
    }
    return deriveServiceUrl(getStatusBackendUrl(), '/health');
}
function getStatusServerUnavailableMessage() {
    return new StatusServerUnavailableError(getStatusServerHealthUrl()).message;
}
function toStatusServerUnavailableError() {
    return new StatusServerUnavailableError(getStatusServerHealthUrl());
}
async function getExecutionServerState() {
    try {
        const response = await requestJson({
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
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function tryAcquireExecutionLease() {
    try {
        const response = await requestJson({
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
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function refreshExecutionLease(token) {
    try {
        await requestJson({
            url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/heartbeat`,
            method: 'POST',
            timeoutMs: 2000,
            body: JSON.stringify({ token }),
        });
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function releaseExecutionLease(token) {
    try {
        await requestJson({
            url: `${getExecutionServiceUrl().replace(/\/$/u, '')}/release`,
            method: 'POST',
            timeoutMs: 2000,
            body: JSON.stringify({ token }),
        });
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function ensureStatusServerReachable() {
    try {
        const response = await requestJson({
            url: getStatusServerHealthUrl(),
            method: 'GET',
            timeoutMs: 2000,
        });
        if (!response || response.ok !== true) {
            throw new Error('Health endpoint did not return ok=true.');
        }
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function notifyStatusBackend(options) {
    const body = {
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
    if (options.running && options.phase) {
        body.phase = options.phase;
    }
    if (options.running
        && options.chunkIndex
        && options.chunkTotal
        && options.chunkIndex > 0
        && options.chunkTotal > 0) {
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
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
function getConfigServiceUrl() {
    const configuredUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
    if (configuredUrl && configuredUrl.trim()) {
        return configuredUrl.trim();
    }
    return deriveServiceUrl(getStatusBackendUrl(), '/config');
}
function getConfigPath() {
    return path.join(getRuntimeRoot(), 'config.json');
}
function getDefaultConfigObject() {
    const runtimePaths = initializeRuntime();
    return {
        Version: exports.SIFTKIT_VERSION,
        Backend: 'llama.cpp',
        Model: 'qwen3.5-9b-instruct-q4_k_m',
        PolicyMode: 'conservative',
        RawLogRetention: true,
        LlamaCpp: {
            BaseUrl: 'http://127.0.0.1:8080',
            NumCtx: getDefaultNumCtx(),
            ModelPath: null,
            Temperature: 0.2,
            TopP: 0.95,
            TopK: 20,
            MinP: 0.0,
            PresencePenalty: 0.0,
            RepetitionPenalty: 1.0,
            MaxTokens: 4096,
            GpuLayers: 999,
            Threads: -1,
            FlashAttention: true,
            ParallelSlots: 1,
            Reasoning: 'off',
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
function toPersistedConfigObject(config) {
    return {
        Version: config.Version,
        Backend: config.Backend,
        Model: config.Model,
        PolicyMode: config.PolicyMode,
        RawLogRetention: Boolean(config.RawLogRetention),
        LlamaCpp: {
            BaseUrl: config.LlamaCpp.BaseUrl,
            NumCtx: Number(config.LlamaCpp.NumCtx),
            ...(config.LlamaCpp.ModelPath === undefined ? {} : { ModelPath: config.LlamaCpp.ModelPath }),
            Temperature: Number(config.LlamaCpp.Temperature),
            TopP: Number(config.LlamaCpp.TopP),
            TopK: Number(config.LlamaCpp.TopK),
            MinP: Number(config.LlamaCpp.MinP),
            PresencePenalty: Number(config.LlamaCpp.PresencePenalty),
            RepetitionPenalty: Number(config.LlamaCpp.RepetitionPenalty),
            ...(config.LlamaCpp.MaxTokens === undefined ? {} : { MaxTokens: config.LlamaCpp.MaxTokens }),
            ...(config.LlamaCpp.GpuLayers === undefined ? {} : { GpuLayers: config.LlamaCpp.GpuLayers }),
            ...(config.LlamaCpp.Threads === undefined ? {} : { Threads: config.LlamaCpp.Threads }),
            ...(config.LlamaCpp.FlashAttention === undefined ? {} : { FlashAttention: config.LlamaCpp.FlashAttention }),
            ...(config.LlamaCpp.ParallelSlots === undefined ? {} : { ParallelSlots: config.LlamaCpp.ParallelSlots }),
            ...(config.LlamaCpp.Reasoning === undefined ? {} : { Reasoning: config.LlamaCpp.Reasoning }),
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
function updateRuntimePaths(config) {
    return {
        ...config,
        Paths: initializeRuntime(),
    };
}
function normalizeConfig(config) {
    const updated = JSON.parse(JSON.stringify(config));
    const defaults = getDefaultConfigObject();
    let changed = false;
    let legacyMaxInputCharactersValue = null;
    let legacyMaxInputCharactersRemoved = false;
    updated.Thresholds ??= { ...defaults.Thresholds };
    updated.Interactive ??= { ...defaults.Interactive };
    const legacyOllama = updated.Ollama;
    if (legacyOllama && !updated.LlamaCpp) {
        updated.LlamaCpp = {
            BaseUrl: String(legacyOllama.BaseUrl || defaults.LlamaCpp.BaseUrl),
            NumCtx: Number(legacyOllama.NumCtx || defaults.LlamaCpp.NumCtx),
            ModelPath: defaults.LlamaCpp.ModelPath,
            Temperature: Number(legacyOllama.Temperature ?? defaults.LlamaCpp.Temperature),
            TopP: Number(legacyOllama.TopP ?? defaults.LlamaCpp.TopP),
            TopK: Number(legacyOllama.TopK ?? defaults.LlamaCpp.TopK),
            MinP: Number(legacyOllama.MinP ?? defaults.LlamaCpp.MinP),
            PresencePenalty: Number(legacyOllama.PresencePenalty ?? defaults.LlamaCpp.PresencePenalty),
            RepetitionPenalty: Number(legacyOllama.RepetitionPenalty ?? defaults.LlamaCpp.RepetitionPenalty),
            ...(legacyOllama.NumPredict === undefined ? {} : { MaxTokens: legacyOllama.NumPredict }),
            GpuLayers: defaults.LlamaCpp.GpuLayers,
            Threads: defaults.LlamaCpp.Threads,
            FlashAttention: defaults.LlamaCpp.FlashAttention,
            ParallelSlots: defaults.LlamaCpp.ParallelSlots,
            Reasoning: defaults.LlamaCpp.Reasoning,
        };
        changed = true;
    }
    delete updated.Ollama;
    updated.LlamaCpp ??= { ...defaults.LlamaCpp };
    if (updated.Backend === 'ollama') {
        updated.Backend = defaults.Backend;
        changed = true;
    }
    if (!updated.LlamaCpp.BaseUrl) {
        updated.LlamaCpp.BaseUrl = defaults.LlamaCpp.BaseUrl;
        changed = true;
    }
    if (!updated.LlamaCpp.NumCtx || Number(updated.LlamaCpp.NumCtx) <= 0) {
        updated.LlamaCpp.NumCtx = defaults.LlamaCpp.NumCtx;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'Temperature')) {
        updated.LlamaCpp.Temperature = defaults.LlamaCpp.Temperature;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'ModelPath')) {
        updated.LlamaCpp.ModelPath = defaults.LlamaCpp.ModelPath;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'TopP')) {
        updated.LlamaCpp.TopP = defaults.LlamaCpp.TopP;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'TopK')) {
        updated.LlamaCpp.TopK = defaults.LlamaCpp.TopK;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'MinP')) {
        updated.LlamaCpp.MinP = defaults.LlamaCpp.MinP;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'PresencePenalty')) {
        updated.LlamaCpp.PresencePenalty = defaults.LlamaCpp.PresencePenalty;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'RepetitionPenalty')) {
        updated.LlamaCpp.RepetitionPenalty = defaults.LlamaCpp.RepetitionPenalty;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'MaxTokens')) {
        updated.LlamaCpp.MaxTokens = defaults.LlamaCpp.MaxTokens;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'GpuLayers')) {
        updated.LlamaCpp.GpuLayers = defaults.LlamaCpp.GpuLayers;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'Threads')) {
        updated.LlamaCpp.Threads = defaults.LlamaCpp.Threads;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'FlashAttention')) {
        updated.LlamaCpp.FlashAttention = defaults.LlamaCpp.FlashAttention;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'ParallelSlots')) {
        updated.LlamaCpp.ParallelSlots = defaults.LlamaCpp.ParallelSlots;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.LlamaCpp, 'Reasoning')) {
        updated.LlamaCpp.Reasoning = defaults.LlamaCpp.Reasoning;
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
        }
        else {
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
    if (updated.Model === exports.SIFT_PREVIOUS_DEFAULT_MODEL) {
        updated.Model = defaults.Model;
        changed = true;
    }
    const numCtx = Number(updated.LlamaCpp.NumCtx);
    const ratio = Number(updated.Thresholds.ChunkThresholdRatio);
    const isLegacyDefaultSettings = (numCtx === exports.SIFT_LEGACY_DEFAULT_NUM_CTX
        && (!hadExplicitMaxInputCharacters || legacyMaxInputCharactersValue === exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS));
    const isLegacyDerivedSettings = (numCtx === exports.SIFT_LEGACY_DERIVED_NUM_CTX
        && !hadExplicitMaxInputCharacters
        && ratio === defaults.Thresholds.ChunkThresholdRatio);
    const isPreviousDefaultSettings = (numCtx === exports.SIFT_PREVIOUS_DEFAULT_NUM_CTX
        && !hadExplicitMaxInputCharacters
        && ratio === defaults.Thresholds.ChunkThresholdRatio);
    if (isLegacyDefaultSettings || isLegacyDerivedSettings || isPreviousDefaultSettings) {
        updated.LlamaCpp.NumCtx = defaults.LlamaCpp.NumCtx;
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
async function addEffectiveConfigProperties(config, info) {
    const effectiveBudget = await resolveInputCharactersPerContextToken();
    const maxInputCharacters = getDerivedMaxInputCharacters(Number(config.LlamaCpp.NumCtx), effectiveBudget.value);
    const chunkThresholdRatio = Number(config.Thresholds.ChunkThresholdRatio);
    const effectiveChunkThresholdRatio = chunkThresholdRatio > 0 && chunkThresholdRatio <= 1 ? chunkThresholdRatio : 0.92;
    return {
        ...config,
        Effective: {
            ConfigAuthoritative: true,
            BudgetSource: effectiveBudget.budgetSource,
            NumCtx: Number(config.LlamaCpp.NumCtx),
            InputCharactersPerContextToken: effectiveBudget.value,
            MaxInputCharacters: maxInputCharacters,
            ChunkThresholdRatio: chunkThresholdRatio,
            ChunkThresholdCharacters: Math.max(Math.floor(maxInputCharacters * effectiveChunkThresholdRatio), 1),
            LegacyMaxInputCharactersRemoved: info.legacyMaxInputCharactersRemoved,
            LegacyMaxInputCharactersValue: info.legacyMaxInputCharactersValue,
        },
    };
}
async function getConfigFromService() {
    try {
        return await requestJson({
            url: getConfigServiceUrl(),
            method: 'GET',
            timeoutMs: 2000,
        });
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function setConfigInService(config) {
    try {
        return await requestJson({
            url: getConfigServiceUrl(),
            method: 'PUT',
            timeoutMs: 2000,
            body: JSON.stringify(toPersistedConfigObject(config)),
        });
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function saveConfig(config) {
    return setConfigInService(config);
}
async function loadConfig(options) {
    void options;
    let config = await getConfigFromService();
    const update = normalizeConfig(config);
    if (update.info.changed) {
        await saveConfig(update.config);
    }
    return addEffectiveConfigProperties(updateRuntimePaths(update.config), update.info);
}
async function setTopLevelConfigKey(key, value) {
    const config = await loadConfig({ ensure: true });
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
        throw new Error(`Unknown top-level config key: ${key}`);
    }
    config[key] = value;
    await saveConfig(config);
    return loadConfig({ ensure: true });
}
