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
exports.getSummaryFailureContext = getSummaryFailureContext;
exports.attachSummaryFailureContext = attachSummaryFailureContext;
exports.readPlannerDebugPayload = readPlannerDebugPayload;
exports.updatePlannerDebugDump = updatePlannerDebugDump;
exports.createPlannerDebugRecorder = createPlannerDebugRecorder;
exports.finalizePlannerDebugDump = finalizePlannerDebugDump;
exports.buildPlannerFailureErrorMessage = buildPlannerFailureErrorMessage;
exports.writeFailedRequestDump = writeFailedRequestDump;
exports.writeSummaryRequestDump = writeSummaryRequestDump;
exports.appendTestProviderEvent = appendTestProviderEvent;
exports.clearSummaryArtifactState = clearSummaryArtifactState;
exports.traceSummary = traceSummary;
const fs = __importStar(require("node:fs"));
const config_js_1 = require("../config.js");
const paths_js_1 = require("../config/paths.js");
const json_filter_js_1 = require("./planner/json-filter.js");
// ---------- failure context ---------- //
function getSummaryFailureContext(error) {
    if (!error || typeof error !== 'object') {
        return null;
    }
    const context = error.siftkitSummaryFailureContext;
    return context && typeof context === 'object' ? context : null;
}
function attachSummaryFailureContext(error, context) {
    if (!error || typeof error !== 'object') {
        const wrapped = new Error(String(error));
        wrapped.siftkitSummaryFailureContext = context;
        return wrapped;
    }
    const typedError = error;
    typedError.siftkitSummaryFailureContext ??= context;
    return typedError;
}
// ---------- planner debug dump (in-memory, request-scoped) ---------- //
const plannerDebugPayloadByRequestId = new Map();
const plannerFailedArtifactByRequestId = new Set();
function readPlannerDebugPayload(requestId) {
    return plannerDebugPayloadByRequestId.get(requestId) ?? {};
}
function updatePlannerDebugDump(requestId, update) {
    const payload = readPlannerDebugPayload(requestId);
    plannerDebugPayloadByRequestId.set(requestId, update(payload));
}
function createPlannerDebugRecorder(options) {
    const debugPath = (0, paths_js_1.getPlannerDebugPath)(options.requestId);
    updatePlannerDebugDump(options.requestId, () => ({
        requestId: options.requestId,
        command: options.commandText ?? null,
        question: options.question,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode ?? null,
        inputText: options.inputText,
        events: [],
        final: null,
    }));
    return {
        path: debugPath,
        record(event) {
            updatePlannerDebugDump(options.requestId, (payload) => ({
                ...payload,
                events: [...(Array.isArray(payload.events) ? payload.events : []), event],
            }));
        },
        finish(result) {
            updatePlannerDebugDump(options.requestId, (payload) => ({
                ...payload,
                final: result,
            }));
        },
    };
}
// ---------- artifact posting via status backend ---------- //
async function postSummaryArtifact(options) {
    await (0, config_js_1.notifyStatusBackend)({
        running: false,
        requestId: options.requestId,
        artifactType: options.artifactType,
        artifactRequestId: options.requestId,
        artifactPayload: options.artifactPayload,
    });
}
async function finalizePlannerDebugDump(options) {
    updatePlannerDebugDump(options.requestId, (payload) => ({
        ...payload,
        final: {
            ...((0, json_filter_js_1.getRecord)(payload.final) ?? {}),
            finalOutput: options.finalOutput,
            classification: options.classification,
            rawReviewRequired: options.rawReviewRequired,
            providerError: options.providerError ?? null,
        },
    }));
    const payload = readPlannerDebugPayload(options.requestId);
    if (Object.keys(payload).length === 0) {
        return;
    }
    await postSummaryArtifact({
        requestId: options.requestId,
        artifactType: 'planner_debug',
        artifactPayload: payload,
    });
}
function buildPlannerFailureErrorMessage(options) {
    const debugPath = (0, paths_js_1.getPlannerDebugPath)(options.requestId);
    const final = (0, json_filter_js_1.getRecord)(readPlannerDebugPayload(options.requestId).final);
    const reason = options.reason
        || (typeof final?.reason === 'string' ? final.reason : null)
        || 'planner_failed';
    const debugSuffix = fs.existsSync(debugPath)
        ? ` Planner debug dump: ${debugPath}`
        : '';
    return `Planner mode failed: ${reason}.${debugSuffix}`;
}
async function writeFailedRequestDump(options) {
    await postSummaryArtifact({
        requestId: options.requestId,
        artifactType: 'planner_failed',
        artifactPayload: {
            requestId: options.requestId,
            command: options.command ?? null,
            question: options.question,
            inputText: options.inputText,
            error: options.error,
            providerError: options.providerError ?? options.error,
            plannerDebugPath: plannerDebugPayloadByRequestId.has(options.requestId) ? (0, paths_js_1.getPlannerDebugPath)(options.requestId) : null,
        },
    });
    plannerFailedArtifactByRequestId.add(options.requestId);
}
async function writeSummaryRequestDump(options) {
    await postSummaryArtifact({
        requestId: options.requestId,
        artifactType: 'summary_request',
        artifactPayload: {
            requestId: options.requestId,
            command: options.command ?? null,
            question: options.question,
            inputText: options.inputText,
            backend: options.backend,
            model: options.model,
            classification: options.classification ?? null,
            ...(options.rawReviewRequired ? { rawReviewRequired: true } : {}),
            summary: options.summary ?? null,
            providerError: options.providerError ?? null,
            error: options.error ?? null,
            plannerDebugPath: plannerDebugPayloadByRequestId.has(options.requestId) ? (0, paths_js_1.getPlannerDebugPath)(options.requestId) : null,
            failedRequestPath: plannerFailedArtifactByRequestId.has(options.requestId) ? (0, paths_js_1.getPlannerFailedPath)(options.requestId) : null,
        },
    });
}
function appendTestProviderEvent(event) {
    const logPath = process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
    if (!logPath || !logPath.trim()) {
        return;
    }
    fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}
function clearSummaryArtifactState(requestId) {
    plannerDebugPayloadByRequestId.delete(requestId);
    plannerFailedArtifactByRequestId.delete(requestId);
}
function traceSummary(message) {
    if (process.env.SIFTKIT_TRACE_SUMMARY !== '1') {
        return;
    }
    process.stderr.write(`[siftkit-trace ${new Date().toISOString()}] summary ${message}\n`);
}
