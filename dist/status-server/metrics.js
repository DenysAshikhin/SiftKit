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
exports.getDefaultMetrics = getDefaultMetrics;
exports.normalizeMetrics = normalizeMetrics;
exports.readMetrics = readMetrics;
exports.writeMetrics = writeMetrics;
const fs = __importStar(require("node:fs"));
const http_utils_js_1 = require("./http-utils.js");
function getDefaultMetrics() {
    return {
        inputCharactersTotal: 0,
        outputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        promptCacheTokensTotal: 0,
        promptEvalTokensTotal: 0,
        requestDurationMsTotal: 0,
        completedRequestCount: 0,
        updatedAtUtc: null,
    };
}
function normalizeMetrics(input) {
    const metrics = getDefaultMetrics();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return metrics;
    }
    const record = input;
    if (Number.isFinite(record.inputCharactersTotal) && Number(record.inputCharactersTotal) >= 0) {
        metrics.inputCharactersTotal = Number(record.inputCharactersTotal);
    }
    if (Number.isFinite(record.outputCharactersTotal) && Number(record.outputCharactersTotal) >= 0) {
        metrics.outputCharactersTotal = Number(record.outputCharactersTotal);
    }
    if (Number.isFinite(record.inputTokensTotal) && Number(record.inputTokensTotal) >= 0) {
        metrics.inputTokensTotal = Number(record.inputTokensTotal);
    }
    if (Number.isFinite(record.outputTokensTotal) && Number(record.outputTokensTotal) >= 0) {
        metrics.outputTokensTotal = Number(record.outputTokensTotal);
    }
    if (Number.isFinite(record.thinkingTokensTotal) && Number(record.thinkingTokensTotal) >= 0) {
        metrics.thinkingTokensTotal = Number(record.thinkingTokensTotal);
    }
    if (Number.isFinite(record.promptCacheTokensTotal) && Number(record.promptCacheTokensTotal) >= 0) {
        metrics.promptCacheTokensTotal = Number(record.promptCacheTokensTotal);
    }
    if (Number.isFinite(record.promptEvalTokensTotal) && Number(record.promptEvalTokensTotal) >= 0) {
        metrics.promptEvalTokensTotal = Number(record.promptEvalTokensTotal);
    }
    if (Number.isFinite(record.requestDurationMsTotal) && Number(record.requestDurationMsTotal) >= 0) {
        metrics.requestDurationMsTotal = Number(record.requestDurationMsTotal);
    }
    if (Number.isFinite(record.completedRequestCount) && Number(record.completedRequestCount) >= 0) {
        metrics.completedRequestCount = Number(record.completedRequestCount);
    }
    if (typeof record.updatedAtUtc === 'string' && record.updatedAtUtc.trim()) {
        metrics.updatedAtUtc = record.updatedAtUtc;
    }
    return metrics;
}
function readMetrics(metricsPath) {
    if (!fs.existsSync(metricsPath)) {
        return getDefaultMetrics();
    }
    try {
        return normalizeMetrics(JSON.parse(fs.readFileSync(metricsPath, 'utf8')));
    }
    catch {
        return getDefaultMetrics();
    }
}
function writeMetrics(metricsPath, metrics) {
    (0, http_utils_js_1.writeText)(metricsPath, `${JSON.stringify(normalizeMetrics(metrics), null, 2)}\n`);
}
