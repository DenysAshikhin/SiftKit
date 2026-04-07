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
exports.getRepoLocalRuntimeRoot = getRepoLocalRuntimeRoot;
exports.getRepoLocalLogsPath = getRepoLocalLogsPath;
exports.getRuntimeRoot = getRuntimeRoot;
exports.initializeRuntime = initializeRuntime;
exports.getConfigPath = getConfigPath;
exports.getStatusDirectory = getStatusDirectory;
exports.getInferenceStatusPath = getInferenceStatusPath;
exports.getIdleSummarySnapshotsPath = getIdleSummarySnapshotsPath;
exports.getMetricsDirectory = getMetricsDirectory;
exports.getObservedBudgetStatePath = getObservedBudgetStatePath;
exports.getCompressionMetricsPath = getCompressionMetricsPath;
exports.getRuntimeLogsPath = getRuntimeLogsPath;
exports.getSummaryRequestLogsDirectory = getSummaryRequestLogsDirectory;
exports.getSummaryRequestLogPath = getSummaryRequestLogPath;
exports.getPlannerFailedLogsDirectory = getPlannerFailedLogsDirectory;
exports.getPlannerFailedPath = getPlannerFailedPath;
exports.getPlannerDebugPath = getPlannerDebugPath;
exports.getAbandonedLogsDirectory = getAbandonedLogsDirectory;
exports.getAbandonedRequestPath = getAbandonedRequestPath;
exports.getRepoSearchLogRoot = getRepoSearchLogRoot;
exports.getRepoSearchSuccessfulDirectory = getRepoSearchSuccessfulDirectory;
exports.getRepoSearchFailedDirectory = getRepoSearchFailedDirectory;
exports.getChatSessionsRoot = getChatSessionsRoot;
exports.getChatSessionPath = getChatSessionPath;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const fs_js_1 = require("../lib/fs.js");
const paths_js_1 = require("../lib/paths.js");
function getConfiguredStatusPath() {
    const primary = process.env.sift_kit_status;
    if (primary && primary.trim()) {
        return primary.trim();
    }
    const secondary = process.env.SIFTKIT_STATUS_PATH;
    return secondary && secondary.trim() ? secondary.trim() : '';
}
function isRuntimeRootWritable(candidate) {
    if (!candidate || !candidate.trim()) {
        return false;
    }
    try {
        const fullPath = path.resolve(candidate);
        (0, fs_js_1.ensureDirectory)(fullPath);
        const probePath = path.join(fullPath, `${Math.random().toString(16).slice(2)}.tmp`);
        (0, fs_js_1.writeUtf8NoBom)(probePath, 'probe');
        fs.rmSync(probePath, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
function getRepoLocalRuntimeRoot() {
    const repoRoot = (0, paths_js_1.findNearestSiftKitRepoRoot)();
    return repoRoot ? path.resolve(repoRoot, '.siftkit') : null;
}
function getRepoLocalLogsPath() {
    const runtimeRoot = getRepoLocalRuntimeRoot();
    return runtimeRoot ? path.resolve(runtimeRoot, 'logs') : null;
}
/**
 * Resolves the active runtime-root directory by inspecting (in order):
 *   1. `sift_kit_status` / `SIFTKIT_STATUS_PATH` env vars — the caller points
 *      at a status file, we walk up to find the runtime root containing
 *      `<root>/status/inference.txt`.
 *   2. The repo-local `.siftkit/` directory under the nearest SiftKit repo.
 *   3. `%USERPROFILE%/.siftkit`.
 *   4. `<cwd>/.codex/siftkit`.
 *   5. `%TEMP%/siftkit` as a last resort.
 *
 * Each candidate is tested for writability before being returned.
 */
function getRuntimeRoot() {
    const configuredStatusPath = getConfiguredStatusPath();
    if (configuredStatusPath) {
        const absoluteStatusPath = path.resolve(configuredStatusPath);
        const statusDirectory = path.dirname(absoluteStatusPath);
        if (path.basename(statusDirectory).toLowerCase() === 'status') {
            return path.resolve(path.dirname(statusDirectory));
        }
        return path.resolve(statusDirectory);
    }
    const candidates = [];
    const repoRoot = (0, paths_js_1.findNearestSiftKitRepoRoot)();
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
/** Creates (mkdir -p) the standard runtime subdirectories and returns their paths. */
function initializeRuntime() {
    const runtimeRoot = (0, fs_js_1.ensureDirectory)(getRuntimeRoot());
    const logs = (0, fs_js_1.ensureDirectory)(path.join(runtimeRoot, 'logs'));
    const evalRoot = (0, fs_js_1.ensureDirectory)(path.join(runtimeRoot, 'eval'));
    const evalFixtures = (0, fs_js_1.ensureDirectory)(path.join(evalRoot, 'fixtures'));
    const evalResults = (0, fs_js_1.ensureDirectory)(path.join(evalRoot, 'results'));
    return {
        RuntimeRoot: runtimeRoot,
        Logs: logs,
        EvalFixtures: evalFixtures,
        EvalResults: evalResults,
    };
}
// ---------- top-level files ---------- //
function getConfigPath() {
    return path.join(getRuntimeRoot(), 'config.json');
}
// ---------- status/ ---------- //
function getStatusDirectory() {
    return path.join(getRuntimeRoot(), 'status');
}
function getInferenceStatusPath() {
    const configuredPath = process.env.sift_kit_status;
    if (configuredPath && configuredPath.trim()) {
        return path.resolve(configuredPath);
    }
    return path.join(getStatusDirectory(), 'inference.txt');
}
function getIdleSummarySnapshotsPath() {
    return path.join(getStatusDirectory(), 'idle-summary.sqlite');
}
// ---------- metrics/ ---------- //
function getMetricsDirectory() {
    return path.join(getRuntimeRoot(), 'metrics');
}
function getObservedBudgetStatePath() {
    return path.join(getMetricsDirectory(), 'observed-budget.json');
}
function getCompressionMetricsPath() {
    return path.join(getMetricsDirectory(), 'compression.json');
}
// ---------- logs/ ---------- //
function getRuntimeLogsPath() {
    return path.join(getRuntimeRoot(), 'logs');
}
function getSummaryRequestLogsDirectory() {
    return path.join(getRuntimeLogsPath(), 'requests');
}
function getSummaryRequestLogPath(requestId) {
    return path.join(getSummaryRequestLogsDirectory(), `request_${requestId}.json`);
}
function getPlannerFailedLogsDirectory() {
    return path.join(getRuntimeLogsPath(), 'failed');
}
function getPlannerFailedPath(requestId) {
    return path.join(getPlannerFailedLogsDirectory(), `request_failed_${requestId}.json`);
}
function getPlannerDebugPath(requestId) {
    return path.join(getRuntimeLogsPath(), `planner_debug_${requestId}.json`);
}
function getAbandonedLogsDirectory() {
    return path.join(getRuntimeLogsPath(), 'abandoned');
}
function getAbandonedRequestPath(requestId) {
    return path.join(getAbandonedLogsDirectory(), `request_abandoned_${requestId}.json`);
}
// ---------- logs/repo_search/ ---------- //
function getRepoSearchLogRoot() {
    return path.join(getRuntimeLogsPath(), 'repo_search');
}
// Historic spelling kept for backwards compatibility with on-disk layouts
// already created by older server builds.
function getRepoSearchSuccessfulDirectory() {
    return path.join(getRepoSearchLogRoot(), 'succesful');
}
function getRepoSearchFailedDirectory() {
    return path.join(getRepoSearchLogRoot(), 'failed');
}
// ---------- chat/sessions/ ---------- //
function getChatSessionsRoot() {
    return path.join(getRuntimeRoot(), 'chat', 'sessions');
}
function getChatSessionPath(sessionId) {
    return path.join(getChatSessionsRoot(), `session_${sessionId}.json`);
}
