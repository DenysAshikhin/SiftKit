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
exports.buildStatusRequestLogMessage = buildStatusRequestLogMessage;
exports.buildRepoSearchProgressLogMessage = buildRepoSearchProgressLogMessage;
exports.getStatusArtifactPath = getStatusArtifactPath;
exports.loadDashboardRuns = loadDashboardRuns;
exports.buildDashboardRunDetail = buildDashboardRunDetail;
exports.getPromptCacheHitRate = getPromptCacheHitRate;
exports.getCurrentUtcDateKey = getCurrentUtcDateKey;
exports.getSnapshotTotalsBeforeDate = getSnapshotTotalsBeforeDate;
exports.buildLiveTodayMetrics = buildLiveTodayMetrics;
exports.buildDashboardDailyMetricsFromRuns = buildDashboardDailyMetricsFromRuns;
exports.buildDashboardDailyMetricsFromIdleSnapshots = buildDashboardDailyMetricsFromIdleSnapshots;
exports.buildDashboardDailyMetrics = buildDashboardDailyMetrics;
exports.normalizeIdleSummarySnapshotRow = normalizeIdleSummarySnapshotRow;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const paths_js_1 = require("./paths.js");
const formatting_js_1 = require("./formatting.js");
const http_utils_js_1 = require("./http-utils.js");
const metrics_js_1 = require("./metrics.js");
const idle_summary_js_1 = require("./idle-summary.js");
const jsonl_transcript_js_1 = require("../state/jsonl-transcript.js");
function buildStatusRequestLogMessage(input) {
    const { running, requestId = null, terminalState = null, errorMessage = null, characterCount = null, promptCharacterCount = null, promptTokenCount = null, rawInputCharacterCount = null, chunkIndex = null, chunkTotal = null, chunkPath = null, elapsedMs = null, totalElapsedMs = null, outputTokens = null, totalOutputTokens = null, } = input;
    void requestId;
    const statusText = running ? 'true' : 'false';
    let logMessage = `request ${statusText}`;
    if (running) {
        const resolvedPromptCharacterCount = promptCharacterCount ?? characterCount;
        if (rawInputCharacterCount !== null) {
            logMessage += ` raw_chars=${(0, formatting_js_1.formatInteger)(rawInputCharacterCount)}`;
        }
        if (resolvedPromptCharacterCount !== null) {
            logMessage += ` prompt=${(0, formatting_js_1.formatInteger)(resolvedPromptCharacterCount)}`;
            if (promptTokenCount !== null) {
                logMessage += ` (${(0, formatting_js_1.formatInteger)(promptTokenCount)})`;
            }
        }
        if (chunkPath !== null) {
            logMessage += ` chunk ${String(chunkPath)}`;
        }
        else if (chunkIndex !== null && chunkTotal !== null) {
            logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
        }
    }
    else if (terminalState === 'failed') {
        if (rawInputCharacterCount !== null) {
            logMessage += ` raw_chars=${(0, formatting_js_1.formatInteger)(rawInputCharacterCount)}`;
        }
        if (promptCharacterCount !== null) {
            logMessage += ` prompt=${(0, formatting_js_1.formatInteger)(promptCharacterCount)}`;
            if (promptTokenCount !== null) {
                logMessage += ` (${(0, formatting_js_1.formatInteger)(promptTokenCount)})`;
            }
        }
        if (chunkPath !== null) {
            logMessage += ` chunk ${String(chunkPath)}`;
        }
        else if (chunkIndex !== null && chunkTotal !== null) {
            logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
        }
        logMessage += ' failed';
        if (elapsedMs !== null) {
            logMessage += ` elapsed=${(0, formatting_js_1.formatElapsed)(elapsedMs)}`;
        }
        else if (totalElapsedMs !== null) {
            logMessage += ` elapsed=${(0, formatting_js_1.formatElapsed)(totalElapsedMs)}`;
        }
        if (errorMessage) {
            logMessage += ` error=${String(errorMessage)}`;
        }
    }
    else if (totalElapsedMs !== null) {
        logMessage += ` total_elapsed=${(0, formatting_js_1.formatElapsed)(totalElapsedMs)}`;
        if (totalOutputTokens !== null) {
            logMessage += ` output_tokens=${(0, formatting_js_1.formatInteger)(totalOutputTokens)}`;
        }
    }
    else if (elapsedMs !== null) {
        logMessage += ` elapsed=${(0, formatting_js_1.formatElapsed)(elapsedMs)}`;
        if (outputTokens !== null) {
            logMessage += ` output_tokens=${(0, formatting_js_1.formatInteger)(outputTokens)}`;
        }
    }
    return logMessage;
}
function normalizeRepoSearchCommandForLog(command) {
    return String(command || '').replace(/\s+/gu, ' ').trim();
}
function buildRepoSearchProgressLogMessage(event, mode) {
    const commandText = normalizeRepoSearchCommandForLog(event?.command);
    if (!commandText) {
        return null;
    }
    const resolvedMode = String(mode || 'repo_search').trim() || 'repo_search';
    const turnLabel = Number.isFinite(Number(event?.turn))
        ? `${Math.max(1, Math.trunc(Number(event?.turn)))}/${Number.isFinite(Number(event?.maxTurns)) ? Math.max(1, Math.trunc(Number(event?.maxTurns))) : '?'}`
        : '?/?';
    const promptTokenCount = Number.isFinite(Number(event?.promptTokenCount))
        ? (0, formatting_js_1.formatInteger)(Math.max(0, Math.trunc(Number(event?.promptTokenCount))))
        : 'null';
    const elapsedMs = Number.isFinite(Number(event?.elapsedMs))
        ? Math.max(0, Math.trunc(Number(event?.elapsedMs)))
        : 0;
    return `${resolvedMode} command turn=${turnLabel} prompt_tokens=${promptTokenCount} elapsed=${(0, formatting_js_1.formatElapsed)(elapsedMs)} command=${commandText}`;
}
function getStatusArtifactPath(metadata) {
    if (!metadata.artifactType || !metadata.artifactRequestId) {
        return null;
    }
    const logsPath = path.join((0, paths_js_1.getRuntimeRoot)(), 'logs');
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
function parseRequestIdFromFileName(fileName) {
    const match = /request_(.+)\.json$/iu.exec(fileName);
    return match ? match[1] : null;
}
function getRepoSearchTranscriptPath(payload, artifactPath) {
    if (payload && typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()) {
        return payload.transcriptPath;
    }
    const siblingTranscriptPath = artifactPath.replace(/\.json$/iu, '.jsonl');
    return fs.existsSync(siblingTranscriptPath) ? siblingTranscriptPath : null;
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
        promptCacheTokens: Number.isFinite(record.promptCacheTokens) ? Number(record.promptCacheTokens) : null,
        promptEvalTokens: Number.isFinite(record.promptEvalTokens) ? Number(record.promptEvalTokens) : null,
        durationMs: Number.isFinite(record.durationMs) ? Number(record.durationMs) : null,
        rawPaths: record.rawPaths && typeof record.rawPaths === 'object' ? record.rawPaths : {},
    };
}
function loadDashboardRuns(runtimeRoot) {
    const logsRoot = path.join(runtimeRoot, 'logs');
    const byId = new Map();
    for (const requestPath of (0, http_utils_js_1.listFiles)(path.join(logsRoot, 'requests'))) {
        const fileName = path.basename(requestPath);
        if (!/^request_.+\.json$/iu.test(fileName)) {
            continue;
        }
        const payload = (0, http_utils_js_1.safeReadJson)(requestPath);
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
        const startedAtUtc = (typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
            ? payload.createdAtUtc
            : (0, http_utils_js_1.getIsoDateFromStat)(requestPath));
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
            promptCacheTokens: payload.promptCacheTokens ?? null,
            promptEvalTokens: payload.promptEvalTokens ?? null,
            durationMs: payload.requestDurationMs ?? null,
            rawPaths: {
                request: requestPath,
                plannerDebug: fs.existsSync(plannerPath) ? plannerPath : null,
                failedRequest: fs.existsSync(failedPath) ? failedPath : null,
            },
        }));
    }
    for (const failedPath of (0, http_utils_js_1.listFiles)(path.join(logsRoot, 'failed'))) {
        const fileName = path.basename(failedPath);
        const match = /^request_failed_(.+)\.json$/iu.exec(fileName);
        if (!match) {
            continue;
        }
        const payload = (0, http_utils_js_1.safeReadJson)(failedPath);
        if (!payload || typeof payload !== 'object') {
            continue;
        }
        const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : match[1];
        const startedAtUtc = (typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
            ? payload.createdAtUtc
            : (0, http_utils_js_1.getIsoDateFromStat)(failedPath));
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
                promptCacheTokens: payload.promptCacheTokens ?? null,
                promptEvalTokens: payload.promptEvalTokens ?? null,
                durationMs: payload.requestDurationMs ?? null,
                rawPaths: { failedRequest: failedPath },
            }));
        }
    }
    for (const abandonedPath of (0, http_utils_js_1.listFiles)(path.join(logsRoot, 'abandoned'))) {
        const fileName = path.basename(abandonedPath);
        const match = /^request_abandoned_(.+)\.json$/iu.exec(fileName);
        if (!match) {
            continue;
        }
        const payload = (0, http_utils_js_1.safeReadJson)(abandonedPath);
        if (!payload || typeof payload !== 'object') {
            continue;
        }
        const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : match[1];
        const startedAtUtc = (typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
            ? payload.createdAtUtc
            : (0, http_utils_js_1.getIsoDateFromStat)(abandonedPath));
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
                promptCacheTokens: null,
                promptEvalTokens: null,
                durationMs: payload.totalElapsedMs ?? null,
                rawPaths: { abandonedRequest: abandonedPath },
            }));
        }
    }
    for (const folderName of ['failed', 'succesful']) {
        for (const artifactPath of (0, http_utils_js_1.listFiles)(path.join(logsRoot, 'repo_search', folderName))) {
            const fileName = path.basename(artifactPath);
            if (!/^request_.+\.json$/iu.test(fileName)) {
                continue;
            }
            const payload = (0, http_utils_js_1.safeReadJson)(artifactPath);
            if (!payload || typeof payload !== 'object') {
                continue;
            }
            const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
                ? payload.requestId.trim()
                : parseRequestIdFromFileName(fileName);
            if (!requestId) {
                continue;
            }
            const transcriptPath = getRepoSearchTranscriptPath(payload, artifactPath);
            const startedAtUtc = (typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
                ? payload.createdAtUtc
                : (0, http_utils_js_1.getIsoDateFromStat)(artifactPath));
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
                promptCacheTokens: null,
                promptEvalTokens: null,
                durationMs: (0, jsonl_transcript_js_1.getTranscriptDurationMs)(transcriptPath),
                rawPaths: {
                    repoSearch: artifactPath,
                    transcript: transcriptPath,
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
function buildDashboardRunDetail(runtimeRoot, runId) {
    const runs = loadDashboardRuns(runtimeRoot);
    const run = runs.find((entry) => entry.id === runId) || null;
    if (!run) {
        return null;
    }
    const events = [];
    if (run.rawPaths && typeof run.rawPaths === 'object') {
        const raw = run.rawPaths;
        if (raw.transcript) {
            events.push(...(0, jsonl_transcript_js_1.readJsonlEvents)(raw.transcript));
        }
        if (raw.request) {
            const payload = (0, http_utils_js_1.safeReadJson)(raw.request);
            if (payload) {
                events.push({ kind: 'summary_request', at: run.startedAtUtc, payload });
            }
        }
        if (raw.plannerDebug) {
            const payload = (0, http_utils_js_1.safeReadJson)(raw.plannerDebug);
            if (payload) {
                events.push({ kind: 'planner_debug', at: run.startedAtUtc, payload });
            }
        }
        if (raw.failedRequest) {
            const payload = (0, http_utils_js_1.safeReadJson)(raw.failedRequest);
            if (payload) {
                events.push({ kind: 'failed_request', at: run.startedAtUtc, payload });
            }
        }
        if (raw.abandonedRequest) {
            const payload = (0, http_utils_js_1.safeReadJson)(raw.abandonedRequest);
            if (payload) {
                events.push({ kind: 'request_abandoned', at: run.startedAtUtc, payload });
            }
        }
        if (raw.repoSearch) {
            const payload = (0, http_utils_js_1.safeReadJson)(raw.repoSearch);
            if (payload) {
                events.push({ kind: 'repo_search', at: run.startedAtUtc, payload });
            }
        }
    }
    return { run, events };
}
function getPromptCacheHitRate(promptCacheTokens, promptEvalTokens) {
    const cacheTokens = Number(promptCacheTokens) || 0;
    const evalTokens = Number(promptEvalTokens) || 0;
    const totalPromptTokens = cacheTokens + evalTokens;
    if (totalPromptTokens <= 0) {
        return null;
    }
    return cacheTokens / totalPromptTokens;
}
function getCurrentUtcDateKey() {
    return new Date().toISOString().slice(0, 10);
}
function getSnapshotTotalsBeforeDate(database, dateKey) {
    return (0, idle_summary_js_1.querySnapshotTotalsBeforeDate)(database, dateKey);
}
function buildLiveTodayMetrics(currentMetrics, idleSummaryDatabase) {
    const day = getCurrentUtcDateKey();
    const totals = (0, metrics_js_1.normalizeMetrics)(currentMetrics);
    const baseline = getSnapshotTotalsBeforeDate(idleSummaryDatabase, day);
    const completedRequestCount = Number(totals.completedRequestCount) || 0;
    const inputTokensTotal = Number(totals.inputTokensTotal) || 0;
    const outputTokensTotal = Number(totals.outputTokensTotal) || 0;
    const thinkingTokensTotal = Number(totals.thinkingTokensTotal) || 0;
    const promptCacheTokensTotal = Number(totals.promptCacheTokensTotal) || 0;
    const promptEvalTokensTotal = Number(totals.promptEvalTokensTotal) || 0;
    const requestDurationMsTotal = Number(totals.requestDurationMsTotal) || 0;
    const runs = Math.max(0, completedRequestCount - (baseline ? baseline.completedRequestCount : 0));
    const inputTokens = Math.max(0, inputTokensTotal - (baseline ? baseline.inputTokensTotal : 0));
    const outputTokens = Math.max(0, outputTokensTotal - (baseline ? baseline.outputTokensTotal : 0));
    const thinkingTokens = Math.max(0, thinkingTokensTotal - (baseline ? baseline.thinkingTokensTotal : 0));
    const promptCacheTokens = Math.max(0, promptCacheTokensTotal - (baseline ? baseline.promptCacheTokensTotal : 0));
    const promptEvalTokens = Math.max(0, promptEvalTokensTotal - (baseline ? baseline.promptEvalTokensTotal : 0));
    const durationTotalMs = Math.max(0, requestDurationMsTotal - (baseline ? baseline.requestDurationMsTotal : 0));
    return {
        date: day,
        runs,
        inputTokens,
        outputTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
        cacheHitRate: getPromptCacheHitRate(promptCacheTokens, promptEvalTokens),
        successCount: 0,
        failureCount: 0,
        avgDurationMs: runs > 0 ? Math.round(durationTotalMs / runs) : 0,
    };
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
            promptCacheTokens: 0,
            promptEvalTokens: 0,
            cacheHitRate: null,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
            durationTotalMs: 0,
            durationCount: 0,
        };
        current.runs += 1;
        current.inputTokens += Number(run.inputTokens || 0);
        current.outputTokens += Number(run.outputTokens || 0);
        current.thinkingTokens += Number(run.thinkingTokens || 0);
        current.promptCacheTokens += Number(run.promptCacheTokens || 0);
        current.promptEvalTokens += Number(run.promptEvalTokens || 0);
        if (run.status === 'completed') {
            current.successCount += 1;
        }
        else {
            current.failureCount += 1;
        }
        if (Number.isFinite(run.durationMs) && Number(run.durationMs) >= 0) {
            current.durationTotalMs += Number(run.durationMs);
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
        promptCacheTokens: entry.promptCacheTokens,
        promptEvalTokens: entry.promptEvalTokens,
        cacheHitRate: getPromptCacheHitRate(entry.promptCacheTokens, entry.promptEvalTokens),
        successCount: entry.successCount,
        failureCount: entry.failureCount,
        avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}
function buildDashboardDailyMetricsFromIdleSnapshots(database) {
    const rows = (0, idle_summary_js_1.querySnapshotTimeseries)(database);
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
            promptCacheTokens: 0,
            promptEvalTokens: 0,
            cacheHitRate: null,
            successCount: 0,
            failureCount: 0,
            avgDurationMs: 0,
            durationTotalMs: 0,
            durationCount: 0,
        };
        const completedRequestCount = Number(row.completed_request_count) || 0;
        const inputTokensTotal = Number(row.input_tokens_total) || 0;
        const outputTokensTotal = Number(row.output_tokens_total) || 0;
        const thinkingTokensTotal = Number(row.thinking_tokens_total) || 0;
        const promptCacheTokensTotal = Number(row.prompt_cache_tokens_total) || 0;
        const promptEvalTokensTotal = Number(row.prompt_eval_tokens_total) || 0;
        const requestDurationMsTotal = Number(row.request_duration_ms_total) || 0;
        const deltaRuns = Math.max(0, previous ? completedRequestCount - previous.completedRequestCount : completedRequestCount);
        const deltaInput = Math.max(0, previous ? inputTokensTotal - previous.inputTokensTotal : inputTokensTotal);
        const deltaOutput = Math.max(0, previous ? outputTokensTotal - previous.outputTokensTotal : outputTokensTotal);
        const deltaThinking = Math.max(0, previous ? thinkingTokensTotal - previous.thinkingTokensTotal : thinkingTokensTotal);
        const deltaPromptCache = Math.max(0, previous ? promptCacheTokensTotal - previous.promptCacheTokensTotal : promptCacheTokensTotal);
        const deltaPromptEval = Math.max(0, previous ? promptEvalTokensTotal - previous.promptEvalTokensTotal : promptEvalTokensTotal);
        const deltaDuration = Math.max(0, previous ? requestDurationMsTotal - previous.requestDurationMsTotal : requestDurationMsTotal);
        current.runs += deltaRuns;
        current.inputTokens += deltaInput;
        current.outputTokens += deltaOutput;
        current.thinkingTokens += deltaThinking;
        current.promptCacheTokens += deltaPromptCache;
        current.promptEvalTokens += deltaPromptEval;
        current.durationTotalMs += deltaDuration;
        current.durationCount += deltaRuns;
        byDay.set(day, current);
        previous = {
            completedRequestCount,
            inputTokensTotal,
            outputTokensTotal,
            thinkingTokensTotal,
            promptCacheTokensTotal,
            promptEvalTokensTotal,
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
        promptCacheTokens: entry.promptCacheTokens,
        promptEvalTokens: entry.promptEvalTokens,
        cacheHitRate: getPromptCacheHitRate(entry.promptCacheTokens, entry.promptEvalTokens),
        successCount: entry.successCount,
        failureCount: entry.failureCount,
        avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}
function buildDashboardDailyMetrics(runtimeRoot, idleSummaryDatabase, currentMetrics) {
    const runDays = buildDashboardDailyMetricsFromRuns(runtimeRoot);
    const runByDay = new Map(runDays.map((day) => [day.date, day]));
    const liveToday = buildLiveTodayMetrics(currentMetrics, idleSummaryDatabase);
    const snapshotDays = buildDashboardDailyMetricsFromIdleSnapshots(idleSummaryDatabase);
    if (snapshotDays.length > 0) {
        const merged = snapshotDays.map((day) => {
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
        const todayRunDay = runByDay.get(liveToday.date);
        const liveTodayMerged = todayRunDay
            ? { ...liveToday, successCount: todayRunDay.successCount, failureCount: todayRunDay.failureCount }
            : liveToday;
        const mergedWithoutToday = merged.filter((day) => day.date !== liveToday.date);
        return [...mergedWithoutToday, liveTodayMerged].sort((left, right) => left.date.localeCompare(right.date));
    }
    const todayRunDay = runByDay.get(liveToday.date);
    const liveTodayMerged = todayRunDay
        ? { ...liveToday, successCount: todayRunDay.successCount, failureCount: todayRunDay.failureCount }
        : liveToday;
    const runDaysWithoutToday = runDays.filter((day) => day.date !== liveToday.date);
    return [...runDaysWithoutToday, liveTodayMerged].sort((left, right) => left.date.localeCompare(right.date));
}
function normalizeIdleSummarySnapshotRow(row) {
    if (!row || typeof row !== 'object') {
        return null;
    }
    const snapshot = {
        emittedAtUtc: typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : '',
        completedRequestCount: Number(row.completed_request_count) || 0,
        inputCharactersTotal: Number(row.input_characters_total) || 0,
        outputCharactersTotal: Number(row.output_characters_total) || 0,
        inputTokensTotal: Number(row.input_tokens_total) || 0,
        outputTokensTotal: Number(row.output_tokens_total) || 0,
        thinkingTokensTotal: Number(row.thinking_tokens_total) || 0,
        promptCacheTokensTotal: Number(row.prompt_cache_tokens_total) || 0,
        promptEvalTokensTotal: Number(row.prompt_eval_tokens_total) || 0,
        savedTokens: Number(row.saved_tokens) || 0,
        savedPercent: Number.isFinite(row.saved_percent) ? Number(row.saved_percent) : Number.NaN,
        compressionRatio: Number.isFinite(row.compression_ratio) ? Number(row.compression_ratio) : Number.NaN,
        requestDurationMsTotal: Number(row.request_duration_ms_total) || 0,
        avgRequestMs: Number.isFinite(row.avg_request_ms) ? Number(row.avg_request_ms) : Number.NaN,
        avgTokensPerSecond: Number.isFinite(row.avg_tokens_per_second) ? Number(row.avg_tokens_per_second) : Number.NaN,
        avgOutputTokensPerRequest: Number.NaN,
        inputCharactersPerContextToken: null,
        chunkThresholdCharacters: null,
        summaryText: '',
    };
    snapshot.summaryText = (0, idle_summary_js_1.buildIdleSummarySnapshotMessage)(snapshot);
    return snapshot;
}
