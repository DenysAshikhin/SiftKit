"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveServiceUrl = deriveServiceUrl;
exports.getStatusBackendUrl = getStatusBackendUrl;
exports.getStatusServerHealthUrl = getStatusServerHealthUrl;
exports.getStatusServerUnavailableMessage = getStatusServerUnavailableMessage;
exports.toStatusServerUnavailableError = toStatusServerUnavailableError;
exports.getStatusSnapshot = getStatusSnapshot;
exports.ensureStatusServerReachable = ensureStatusServerReachable;
exports.notifyStatusBackend = notifyStatusBackend;
const http_js_1 = require("../lib/http.js");
const paths_js_1 = require("./paths.js");
const errors_js_1 = require("./errors.js");
function deriveServiceUrl(configuredUrl, nextPath) {
    const target = new URL(configuredUrl);
    target.pathname = nextPath;
    target.search = '';
    target.hash = '';
    return target.toString();
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
function getStatusServerHealthUrl() {
    const configuredConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
    if (configuredConfigUrl && configuredConfigUrl.trim()) {
        return deriveServiceUrl(configuredConfigUrl.trim(), '/health');
    }
    return deriveServiceUrl(getStatusBackendUrl(), '/health');
}
function getStatusServerUnavailableMessage() {
    return new errors_js_1.StatusServerUnavailableError(getStatusServerHealthUrl()).message;
}
function toStatusServerUnavailableError() {
    return new errors_js_1.StatusServerUnavailableError(getStatusServerHealthUrl());
}
async function getStatusSnapshot() {
    try {
        return await (0, http_js_1.requestJson)({
            url: getStatusBackendUrl(),
            method: 'GET',
            timeoutMs: 2000,
        });
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
async function ensureStatusServerReachable() {
    try {
        const response = await (0, http_js_1.requestJson)({
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
        statusPath: (0, paths_js_1.getInferenceStatusPath)(),
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
    if (!options.running
        && options.artifactPayload
        && typeof options.artifactPayload === 'object'
        && !Array.isArray(options.artifactPayload)) {
        body.artifactPayload = options.artifactPayload;
    }
    try {
        await (0, http_js_1.requestJson)({
            url: (options.statusBackendUrl && options.statusBackendUrl.trim()) ? options.statusBackendUrl.trim() : getStatusBackendUrl(),
            method: 'POST',
            timeoutMs: 2000,
            body: JSON.stringify(body),
        });
    }
    catch {
        throw toStatusServerUnavailableError();
    }
}
