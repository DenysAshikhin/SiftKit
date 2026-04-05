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
exports.STATUS_FOREIGN_LOCK = exports.STATUS_LOCK_REQUESTED = exports.STATUS_FALSE = exports.STATUS_TRUE = void 0;
exports.normalizeStatusText = normalizeStatusText;
exports.ensureStatusFile = ensureStatusFile;
exports.readStatusText = readStatusText;
exports.parseRunning = parseRunning;
exports.parseStatusMetadata = parseStatusMetadata;
const fs = __importStar(require("node:fs"));
const http_utils_js_1 = require("./http-utils.js");
exports.STATUS_TRUE = 'true';
exports.STATUS_FALSE = 'false';
exports.STATUS_LOCK_REQUESTED = 'lock_requested';
exports.STATUS_FOREIGN_LOCK = 'foreign_lock';
function normalizeStatusText(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === exports.STATUS_TRUE ||
        normalized === exports.STATUS_FALSE ||
        normalized === exports.STATUS_LOCK_REQUESTED ||
        normalized === exports.STATUS_FOREIGN_LOCK) {
        return normalized;
    }
    return exports.STATUS_FALSE;
}
function ensureStatusFile(targetPath) {
    if (!fs.existsSync(targetPath)) {
        (0, http_utils_js_1.writeText)(targetPath, exports.STATUS_FALSE);
    }
}
function readStatusText(targetPath) {
    try {
        return normalizeStatusText(fs.readFileSync(targetPath, 'utf8'));
    }
    catch {
        return exports.STATUS_FALSE;
    }
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
            if (normalized === exports.STATUS_TRUE || normalized === exports.STATUS_FALSE) {
                return normalized === exports.STATUS_TRUE;
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
    }
    catch {
        const normalized = normalizeStatusText(bodyText);
        if (normalized === exports.STATUS_TRUE || normalized === exports.STATUS_FALSE) {
            return normalized === exports.STATUS_TRUE;
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
        promptCacheTokens: null,
        promptEvalTokens: null,
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
        if (Number.isFinite(parsed.promptCharacterCount) && Number(parsed.promptCharacterCount) >= 0) {
            metadata.promptCharacterCount = Number(parsed.promptCharacterCount);
        }
        else if (Number.isFinite(parsed.characterCount) && Number(parsed.characterCount) >= 0) {
            metadata.promptCharacterCount = Number(parsed.characterCount);
        }
        if (Number.isFinite(parsed.promptTokenCount) && Number(parsed.promptTokenCount) >= 0) {
            metadata.promptTokenCount = Number(parsed.promptTokenCount);
        }
        if (Number.isFinite(parsed.rawInputCharacterCount) && Number(parsed.rawInputCharacterCount) >= 0) {
            metadata.rawInputCharacterCount = Number(parsed.rawInputCharacterCount);
        }
        if (Number.isFinite(parsed.chunkInputCharacterCount) && Number(parsed.chunkInputCharacterCount) >= 0) {
            metadata.chunkInputCharacterCount = Number(parsed.chunkInputCharacterCount);
        }
        if (typeof parsed.budgetSource === 'string' && parsed.budgetSource.trim()) {
            metadata.budgetSource = parsed.budgetSource.trim();
        }
        if (Number.isFinite(parsed.inputCharactersPerContextToken) && Number(parsed.inputCharactersPerContextToken) > 0) {
            metadata.inputCharactersPerContextToken = Number(parsed.inputCharactersPerContextToken);
        }
        if (Number.isFinite(parsed.chunkThresholdCharacters) && Number(parsed.chunkThresholdCharacters) > 0) {
            metadata.chunkThresholdCharacters = Number(parsed.chunkThresholdCharacters);
        }
        if (Number.isFinite(parsed.chunkIndex) && Number(parsed.chunkIndex) > 0) {
            metadata.chunkIndex = Number(parsed.chunkIndex);
        }
        if (Number.isFinite(parsed.chunkTotal) && Number(parsed.chunkTotal) > 0) {
            metadata.chunkTotal = Number(parsed.chunkTotal);
        }
        if (typeof parsed.chunkPath === 'string' && parsed.chunkPath.trim()) {
            metadata.chunkPath = parsed.chunkPath.trim();
        }
        if (Number.isFinite(parsed.inputTokens) && Number(parsed.inputTokens) >= 0) {
            metadata.inputTokens = Number(parsed.inputTokens);
        }
        if (Number.isFinite(parsed.outputCharacterCount) && Number(parsed.outputCharacterCount) >= 0) {
            metadata.outputCharacterCount = Number(parsed.outputCharacterCount);
        }
        if (Number.isFinite(parsed.outputTokens) && Number(parsed.outputTokens) >= 0) {
            metadata.outputTokens = Number(parsed.outputTokens);
        }
        if (Number.isFinite(parsed.thinkingTokens) && Number(parsed.thinkingTokens) >= 0) {
            metadata.thinkingTokens = Number(parsed.thinkingTokens);
        }
        if (Number.isFinite(parsed.promptCacheTokens) && Number(parsed.promptCacheTokens) >= 0) {
            metadata.promptCacheTokens = Number(parsed.promptCacheTokens);
        }
        if (Number.isFinite(parsed.promptEvalTokens) && Number(parsed.promptEvalTokens) >= 0) {
            metadata.promptEvalTokens = Number(parsed.promptEvalTokens);
        }
        if (Number.isFinite(parsed.requestDurationMs) && Number(parsed.requestDurationMs) >= 0) {
            metadata.requestDurationMs = Number(parsed.requestDurationMs);
        }
        if (parsed.artifactType === 'summary_request'
            || parsed.artifactType === 'planner_debug'
            || parsed.artifactType === 'planner_failed') {
            metadata.artifactType = parsed.artifactType;
        }
        if (typeof parsed.artifactRequestId === 'string' && parsed.artifactRequestId.trim()) {
            metadata.artifactRequestId = parsed.artifactRequestId.trim();
        }
        if (parsed.artifactPayload
            && typeof parsed.artifactPayload === 'object'
            && !Array.isArray(parsed.artifactPayload)) {
            metadata.artifactPayload = parsed.artifactPayload;
        }
    }
    catch {
        return metadata;
    }
    return metadata;
}
