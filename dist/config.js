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
exports.MissingObservedBudgetError = exports.StatusServerUnavailableError = exports.SIFT_DEFAULT_PROMPT_PREFIX = exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = exports.SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT = exports.SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_DEFAULT_LLAMA_MODEL_PATH = exports.SIFT_DEFAULT_LLAMA_BASE_URL = exports.SIFT_DEFAULT_LLAMA_MODEL = exports.SIFT_PREVIOUS_DEFAULT_MODEL = exports.SIFT_PREVIOUS_DEFAULT_NUM_CTX = exports.SIFT_LEGACY_DERIVED_NUM_CTX = exports.SIFT_LEGACY_DEFAULT_NUM_CTX = exports.SIFT_DEFAULT_NUM_CTX = exports.SIFTKIT_VERSION = void 0;
exports.ensureDirectory = ensureDirectory;
exports.saveContentAtomically = saveContentAtomically;
exports.getRepoLocalRuntimeRoot = getRepoLocalRuntimeRoot;
exports.getRepoLocalLogsPath = getRepoLocalLogsPath;
exports.getRuntimeRoot = getRuntimeRoot;
exports.initializeRuntime = initializeRuntime;
exports.getDefaultNumCtx = getDefaultNumCtx;
exports.getConfiguredModel = getConfiguredModel;
exports.getConfiguredPromptPrefix = getConfiguredPromptPrefix;
exports.getConfiguredLlamaBaseUrl = getConfiguredLlamaBaseUrl;
exports.getConfiguredLlamaNumCtx = getConfiguredLlamaNumCtx;
exports.getConfiguredLlamaSetting = getConfiguredLlamaSetting;
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
exports.SIFT_DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
exports.SIFT_DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
exports.SIFT_DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
exports.SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-35B-4bit-150k-no-thinking.ps1';
exports.SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k.ps1';
exports.SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k-thinking.ps1';
exports.SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\start-qwen35-9b-q8-200k-thinking-managed.ps1';
exports.SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\stop-llama-server.ps1';
exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = 32_000;
exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = 2.5;
exports.SIFT_DEFAULT_PROMPT_PREFIX = 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.';
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
    constructor(message = 'SiftKit status server did not provide usable input character/token totals. Refusing to derive chunk budgets from the hardcoded fallback; run at least one successful request or fix status metrics first.') {
        super(message);
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
function isRetryableFsError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = 'code' in error ? String(error.code ?? '') : '';
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}
function saveContentAtomically(filePath, content) {
    const directory = path.dirname(filePath);
    ensureDirectory(directory);
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const tempPath = path.join(directory, `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`);
        try {
            writeUtf8NoBom(tempPath, content);
            fs.renameSync(tempPath, filePath);
            return;
        }
        catch (error) {
            lastError = error;
            try {
                fs.rmSync(tempPath, { force: true });
            }
            catch {
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
function findNearestSiftKitRepoRoot(startPath = process.cwd()) {
    let currentPath = path.resolve(startPath);
    for (;;) {
        const packagePath = path.join(currentPath, 'package.json');
        if (fs.existsSync(packagePath)) {
            try {
                const parsed = parseJsonText(fs.readFileSync(packagePath, 'utf8'));
                if (parsed?.name === 'siftkit') {
                    return currentPath;
                }
            }
            catch {
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
function getRepoLocalRuntimeRoot() {
    const repoRoot = findNearestSiftKitRepoRoot();
    return repoRoot ? path.resolve(repoRoot, '.siftkit') : null;
}
function getRepoLocalLogsPath() {
    const runtimeRoot = getRepoLocalRuntimeRoot();
    return runtimeRoot ? path.resolve(runtimeRoot, 'logs') : null;
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
    const repoRoot = findNearestSiftKitRepoRoot();
    if (repoRoot) {
        candidates.push(path.resolve(repoRoot, '.siftkit'));
    }
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
function getCompatRuntimeLlamaCpp(config) {
    return config.Runtime?.LlamaCpp ?? config.LlamaCpp ?? {};
}
function getFinitePositiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function getConfiguredModel(config) {
    const model = config.Runtime?.Model ?? config.Model;
    if (typeof model === 'string' && model.trim()) {
        return model.trim();
    }
    throw new Error('SiftKit runtime config is missing Model. Start a launcher script first.');
}
function getConfiguredPromptPrefix(config) {
    const promptPrefix = config.PromptPrefix;
    return typeof promptPrefix === 'string' && promptPrefix.trim() ? promptPrefix : undefined;
}
function getConfiguredLlamaBaseUrl(config) {
    const baseUrl = getCompatRuntimeLlamaCpp(config).BaseUrl;
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
        return baseUrl.trim();
    }
    throw new Error('SiftKit runtime config is missing LlamaCpp.BaseUrl. Start a launcher script first.');
}
function getConfiguredLlamaNumCtx(config) {
    const numCtx = getFinitePositiveNumber(getCompatRuntimeLlamaCpp(config).NumCtx);
    if (numCtx !== null) {
        return numCtx;
    }
    throw new Error('SiftKit runtime config is missing LlamaCpp.NumCtx. Start a launcher script first.');
}
function getConfiguredLlamaSetting(config, key) {
    const runtimeValue = getCompatRuntimeLlamaCpp(config)[key];
    return (runtimeValue === undefined || runtimeValue === null) ? undefined : runtimeValue;
}
function getMissingRuntimeFields(config) {
    const missing = [];
    try {
        getConfiguredModel(config);
    }
    catch {
        missing.push('Model');
    }
    try {
        getConfiguredLlamaBaseUrl(config);
    }
    catch {
        missing.push('LlamaCpp.BaseUrl');
    }
    try {
        getConfiguredLlamaNumCtx(config);
    }
    catch {
        missing.push('LlamaCpp.NumCtx');
    }
    return missing;
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
    return getDerivedMaxInputCharacters(getConfiguredLlamaNumCtx(config), getEffectiveInputCharactersPerContextToken(config));
}
function getChunkThresholdCharacters(config) {
    return Math.max(getEffectiveMaxInputCharacters(config), 1);
}
function getInferenceStatusPath() {
    const configuredPath = process.env.sift_kit_status;
    if (configuredPath && configuredPath.trim()) {
        return path.resolve(configuredPath);
    }
    return path.resolve(getRuntimeRoot(), 'status', 'inference.txt');
}
function getObservedBudgetStatePath() {
    return path.resolve(getRuntimeRoot(), 'metrics', 'observed-budget.json');
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
function getDefaultObservedBudgetState() {
    return {
        observedTelemetrySeen: false,
        lastKnownCharsPerToken: null,
        updatedAtUtc: null,
    };
}
function normalizeObservedBudgetState(input) {
    const fallback = getDefaultObservedBudgetState();
    if (!input || typeof input !== 'object') {
        return fallback;
    }
    const parsed = input;
    const lastKnownCharsPerToken = Number(parsed.lastKnownCharsPerToken);
    return {
        observedTelemetrySeen: parsed.observedTelemetrySeen === true && Number.isFinite(lastKnownCharsPerToken) && lastKnownCharsPerToken > 0,
        lastKnownCharsPerToken: Number.isFinite(lastKnownCharsPerToken) && lastKnownCharsPerToken > 0 ? lastKnownCharsPerToken : null,
        updatedAtUtc: typeof parsed.updatedAtUtc === 'string' && parsed.updatedAtUtc.trim() ? parsed.updatedAtUtc : null,
    };
}
function readObservedBudgetState() {
    const statePath = getObservedBudgetStatePath();
    if (!fs.existsSync(statePath)) {
        return getDefaultObservedBudgetState();
    }
    try {
        return normalizeObservedBudgetState(parseJsonText(fs.readFileSync(statePath, 'utf8')));
    }
    catch {
        return getDefaultObservedBudgetState();
    }
}
function writeObservedBudgetState(state) {
    saveContentAtomically(getObservedBudgetStatePath(), `${JSON.stringify(normalizeObservedBudgetState(state), null, 2)}\n`);
}
function tryWriteObservedBudgetState(state) {
    try {
        writeObservedBudgetState(state);
    }
    catch {
        // Observed-budget persistence is advisory. Request execution should continue.
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
    const persistedState = readObservedBudgetState();
    let snapshot;
    try {
        snapshot = await getStatusSnapshot();
    }
    catch {
        if (persistedState.observedTelemetrySeen) {
            throw new MissingObservedBudgetError('SiftKit previously recorded a valid observed chars-per-token budget, but the status server is unavailable or no longer exposes usable totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.');
        }
        return {
            value: exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
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
        throw new MissingObservedBudgetError('SiftKit previously recorded a valid observed chars-per-token budget, but the status server no longer provides usable input character/token totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.');
    }
    return {
        value: exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
        budgetSource: 'ColdStartFixedCharsPerToken',
    };
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
    if (options.requestId && options.requestId.trim()) {
        body.requestId = options.requestId.trim();
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
    if (options.running
        && options.chunkIndex
        && options.chunkTotal
        && options.chunkIndex > 0
        && options.chunkTotal > 0) {
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
        PolicyMode: 'conservative',
        RawLogRetention: true,
        PromptPrefix: exports.SIFT_DEFAULT_PROMPT_PREFIX,
        LlamaCpp: {
            BaseUrl: exports.SIFT_DEFAULT_LLAMA_BASE_URL,
            NumCtx: exports.SIFT_DEFAULT_NUM_CTX,
            ModelPath: exports.SIFT_DEFAULT_LLAMA_MODEL_PATH,
            Temperature: 0.7,
            TopP: 0.8,
            TopK: 20,
            MinP: 0.0,
            PresencePenalty: 1.5,
            RepetitionPenalty: 1.0,
            MaxTokens: 15_000,
            GpuLayers: 999,
            Threads: -1,
            FlashAttention: true,
            ParallelSlots: 1,
            Reasoning: 'off',
        },
        Runtime: {
            Model: exports.SIFT_DEFAULT_LLAMA_MODEL,
            LlamaCpp: {
                BaseUrl: exports.SIFT_DEFAULT_LLAMA_BASE_URL,
                NumCtx: exports.SIFT_DEFAULT_NUM_CTX,
                ModelPath: exports.SIFT_DEFAULT_LLAMA_MODEL_PATH,
                Temperature: 0.7,
                TopP: 0.8,
                TopK: 20,
                MinP: 0.0,
                PresencePenalty: 1.5,
                RepetitionPenalty: 1.0,
                MaxTokens: 15_000,
                GpuLayers: 999,
                Threads: -1,
                FlashAttention: true,
                ParallelSlots: 1,
                Reasoning: 'off',
            },
        },
        Thresholds: {
            MinCharactersForSummary: 500,
            MinLinesForSummary: 16,
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
                StartupScript: exports.SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
                ShutdownScript: exports.SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
                StartupTimeoutMs: 600_000,
                HealthcheckTimeoutMs: 2_000,
                HealthcheckIntervalMs: 1_000,
            },
        },
        Paths: runtimePaths,
    };
}
function toPersistedConfigObject(config) {
    const compatConfig = applyRuntimeCompatibilityView(config);
    return {
        Version: config.Version,
        Backend: config.Backend,
        PolicyMode: config.PolicyMode,
        RawLogRetention: Boolean(config.RawLogRetention),
        PromptPrefix: config.PromptPrefix ?? exports.SIFT_DEFAULT_PROMPT_PREFIX,
        LlamaCpp: {
            ...(compatConfig.LlamaCpp?.BaseUrl === undefined ? {} : { BaseUrl: compatConfig.LlamaCpp?.BaseUrl ?? null }),
            ...(compatConfig.LlamaCpp?.NumCtx === undefined ? {} : { NumCtx: compatConfig.LlamaCpp?.NumCtx ?? null }),
            ...(compatConfig.LlamaCpp?.ModelPath === undefined ? {} : { ModelPath: compatConfig.LlamaCpp?.ModelPath ?? null }),
            ...(compatConfig.LlamaCpp?.Temperature === undefined ? {} : { Temperature: compatConfig.LlamaCpp?.Temperature ?? null }),
            ...(compatConfig.LlamaCpp?.TopP === undefined ? {} : { TopP: compatConfig.LlamaCpp?.TopP ?? null }),
            ...(compatConfig.LlamaCpp?.TopK === undefined ? {} : { TopK: compatConfig.LlamaCpp?.TopK ?? null }),
            ...(compatConfig.LlamaCpp?.MinP === undefined ? {} : { MinP: compatConfig.LlamaCpp?.MinP ?? null }),
            ...(compatConfig.LlamaCpp?.PresencePenalty === undefined ? {} : { PresencePenalty: compatConfig.LlamaCpp?.PresencePenalty ?? null }),
            ...(compatConfig.LlamaCpp?.RepetitionPenalty === undefined ? {} : { RepetitionPenalty: compatConfig.LlamaCpp?.RepetitionPenalty ?? null }),
            ...(compatConfig.LlamaCpp?.MaxTokens === undefined ? {} : { MaxTokens: compatConfig.LlamaCpp?.MaxTokens ?? null }),
            ...(compatConfig.LlamaCpp?.GpuLayers === undefined ? {} : { GpuLayers: compatConfig.LlamaCpp?.GpuLayers ?? null }),
            ...(compatConfig.LlamaCpp?.Threads === undefined ? {} : { Threads: compatConfig.LlamaCpp?.Threads ?? null }),
            ...(compatConfig.LlamaCpp?.FlashAttention === undefined ? {} : { FlashAttention: compatConfig.LlamaCpp?.FlashAttention ?? null }),
            ...(compatConfig.LlamaCpp?.ParallelSlots === undefined ? {} : { ParallelSlots: compatConfig.LlamaCpp?.ParallelSlots ?? null }),
            ...(compatConfig.LlamaCpp?.Reasoning === undefined ? {} : { Reasoning: compatConfig.LlamaCpp?.Reasoning ?? null }),
        },
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
                ...(config.Runtime?.LlamaCpp?.GpuLayers === undefined ? {} : { GpuLayers: config.Runtime?.LlamaCpp?.GpuLayers ?? null }),
                ...(config.Runtime?.LlamaCpp?.Threads === undefined ? {} : { Threads: config.Runtime?.LlamaCpp?.Threads ?? null }),
                ...(config.Runtime?.LlamaCpp?.FlashAttention === undefined ? {} : { FlashAttention: config.Runtime?.LlamaCpp?.FlashAttention ?? null }),
                ...(config.Runtime?.LlamaCpp?.ParallelSlots === undefined ? {} : { ParallelSlots: config.Runtime?.LlamaCpp?.ParallelSlots ?? null }),
                ...(config.Runtime?.LlamaCpp?.Reasoning === undefined ? {} : { Reasoning: config.Runtime?.LlamaCpp?.Reasoning ?? null }),
            },
        },
        Thresholds: {
            MinCharactersForSummary: Number(config.Thresholds.MinCharactersForSummary),
            MinLinesForSummary: Number(config.Thresholds.MinLinesForSummary),
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
function updateRuntimePaths(config) {
    return {
        ...config,
        Paths: initializeRuntime(),
    };
}
function applyRuntimeCompatibilityView(config) {
    const defaults = getDefaultConfigObject();
    const runtime = config.Runtime ?? {};
    const runtimeLlamaCpp = runtime.LlamaCpp ?? {};
    const compatLlamaCpp = {
        ...defaults.LlamaCpp,
        ...config.LlamaCpp,
        ...runtimeLlamaCpp,
    };
    return {
        ...config,
        Model: runtime.Model ?? config.Model ?? defaults.Runtime?.Model ?? null,
        PromptPrefix: config.PromptPrefix ?? exports.SIFT_DEFAULT_PROMPT_PREFIX,
        LlamaCpp: compatLlamaCpp,
    };
}
function normalizeConfig(config) {
    const updated = JSON.parse(JSON.stringify(config));
    const defaults = getDefaultConfigObject();
    let changed = false;
    let legacyMaxInputCharactersValue = null;
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
    const legacyOllama = updated.Ollama;
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
            ...(legacyOllama.NumPredict === undefined ? {} : { MaxTokens: legacyOllama.NumPredict }),
        };
        changed = true;
    }
    delete updated.Ollama;
    if (updated.Backend === 'ollama') {
        updated.Backend = defaults.Backend;
        changed = true;
    }
    if (typeof updated.Model === 'string' && updated.Model.trim() && !updated.Runtime.Model) {
        updated.Runtime.Model = updated.Model;
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(updated, 'Model')) {
        delete updated.Model;
        changed = true;
    }
    const legacyRuntimePromptPrefix = updated.Runtime?.PromptPrefix;
    if ((!updated.PromptPrefix || !String(updated.PromptPrefix).trim()) && typeof legacyRuntimePromptPrefix === 'string' && legacyRuntimePromptPrefix.trim()) {
        updated.PromptPrefix = legacyRuntimePromptPrefix;
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(updated.Runtime ?? {}, 'PromptPrefix')) {
        delete updated.Runtime.PromptPrefix;
        changed = true;
    }
    if (!updated.PromptPrefix || !String(updated.PromptPrefix).trim()) {
        updated.PromptPrefix = defaults.PromptPrefix;
        changed = true;
    }
    for (const key of RUNTIME_OWNED_LLAMA_CPP_KEYS) {
        const value = updated.LlamaCpp[key];
        if (value !== undefined) {
            const runtimeLlamaCpp = updated.Runtime.LlamaCpp;
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
        }
        else {
            legacyMaxInputCharactersValue = null;
        }
    }
    if (Object.prototype.hasOwnProperty.call(updated.Thresholds, 'ChunkThresholdRatio')) {
        delete updated.Thresholds.ChunkThresholdRatio;
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
    if (updated.Server.LlamaCpp.StartupScript === exports.SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT
        || updated.Server.LlamaCpp.StartupScript === exports.SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT
        || updated.Server.LlamaCpp.StartupScript === exports.SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT) {
        updated.Server.LlamaCpp.StartupScript = defaults.Server?.LlamaCpp?.StartupScript ?? null;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'ShutdownScript')) {
        updated.Server.LlamaCpp.ShutdownScript = defaults.Server?.LlamaCpp?.ShutdownScript ?? null;
        changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(updated.Server.LlamaCpp, 'StartupTimeoutMs')) {
        updated.Server.LlamaCpp.StartupTimeoutMs = defaults.Server?.LlamaCpp?.StartupTimeoutMs ?? 600_000;
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
    if (updated.Runtime.Model === exports.SIFT_PREVIOUS_DEFAULT_MODEL) {
        updated.Runtime.Model = null;
        changed = true;
    }
    const numCtx = Number(updated.Runtime.LlamaCpp.NumCtx);
    const isLegacyDefaultSettings = (numCtx === exports.SIFT_LEGACY_DEFAULT_NUM_CTX
        && (!hadExplicitMaxInputCharacters || legacyMaxInputCharactersValue === exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS));
    const isLegacyDerivedSettings = (numCtx === exports.SIFT_LEGACY_DERIVED_NUM_CTX
        && !hadExplicitMaxInputCharacters);
    const isPreviousDefaultSettings = (numCtx === exports.SIFT_PREVIOUS_DEFAULT_NUM_CTX
        && !hadExplicitMaxInputCharacters);
    if (isLegacyDefaultSettings || isLegacyDerivedSettings || isPreviousDefaultSettings) {
        updated.Runtime.LlamaCpp = {
            ...(defaults.Runtime?.LlamaCpp ?? defaults.LlamaCpp),
        };
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
    const missingRuntimeFields = getMissingRuntimeFields(config);
    const runtimeConfigReady = missingRuntimeFields.length === 0;
    const numCtx = runtimeConfigReady ? getConfiguredLlamaNumCtx(config) : null;
    const maxInputCharacters = numCtx === null
        ? null
        : getDerivedMaxInputCharacters(numCtx, effectiveBudget.value);
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
            ChunkThresholdCharacters: maxInputCharacters,
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
            timeoutMs: 130_000,
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
    const runtimeBackfilled = applyRuntimeCompatibilityView(update.config);
    return addEffectiveConfigProperties(updateRuntimePaths(runtimeBackfilled), update.info);
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
