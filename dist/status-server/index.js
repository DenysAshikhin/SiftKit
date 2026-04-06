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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeIdleSummarySnapshotRow = exports.buildDashboardDailyMetrics = exports.buildDashboardRunDetail = exports.loadDashboardRuns = exports.getStatusArtifactPath = exports.buildRepoSearchProgressLogMessage = exports.buildStatusRequestLogMessage = exports.buildIdleMetricsLogMessage = exports.buildIdleSummarySnapshot = exports.formatElapsed = exports.colorize = exports.supportsAnsiColor = exports.getIdleSummarySnapshotsPath = exports.getMetricsPath = exports.getConfigPath = exports.getStatusPath = void 0;
exports.terminateProcessTree = terminateProcessTree;
exports.startStatusServer = startStatusServer;
const http = __importStar(require("node:http"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const paths_js_1 = require("./paths.js");
Object.defineProperty(exports, "getStatusPath", { enumerable: true, get: function () { return paths_js_1.getStatusPath; } });
Object.defineProperty(exports, "getConfigPath", { enumerable: true, get: function () { return paths_js_1.getConfigPath; } });
Object.defineProperty(exports, "getMetricsPath", { enumerable: true, get: function () { return paths_js_1.getMetricsPath; } });
Object.defineProperty(exports, "getIdleSummarySnapshotsPath", { enumerable: true, get: function () { return paths_js_1.getIdleSummarySnapshotsPath; } });
const formatting_js_1 = require("./formatting.js");
Object.defineProperty(exports, "supportsAnsiColor", { enumerable: true, get: function () { return formatting_js_1.supportsAnsiColor; } });
Object.defineProperty(exports, "colorize", { enumerable: true, get: function () { return formatting_js_1.colorize; } });
Object.defineProperty(exports, "formatElapsed", { enumerable: true, get: function () { return formatting_js_1.formatElapsed; } });
const http_utils_js_1 = require("./http-utils.js");
const status_file_js_1 = require("./status-file.js");
const metrics_js_1 = require("./metrics.js");
const idle_summary_js_1 = require("./idle-summary.js");
Object.defineProperty(exports, "buildIdleSummarySnapshot", { enumerable: true, get: function () { return idle_summary_js_1.buildIdleSummarySnapshot; } });
Object.defineProperty(exports, "buildIdleMetricsLogMessage", { enumerable: true, get: function () { return idle_summary_js_1.buildIdleMetricsLogMessage; } });
const config_store_js_1 = require("./config-store.js");
const dashboard_runs_js_1 = require("./dashboard-runs.js");
Object.defineProperty(exports, "buildStatusRequestLogMessage", { enumerable: true, get: function () { return dashboard_runs_js_1.buildStatusRequestLogMessage; } });
Object.defineProperty(exports, "buildRepoSearchProgressLogMessage", { enumerable: true, get: function () { return dashboard_runs_js_1.buildRepoSearchProgressLogMessage; } });
Object.defineProperty(exports, "getStatusArtifactPath", { enumerable: true, get: function () { return dashboard_runs_js_1.getStatusArtifactPath; } });
Object.defineProperty(exports, "loadDashboardRuns", { enumerable: true, get: function () { return dashboard_runs_js_1.loadDashboardRuns; } });
Object.defineProperty(exports, "buildDashboardRunDetail", { enumerable: true, get: function () { return dashboard_runs_js_1.buildDashboardRunDetail; } });
Object.defineProperty(exports, "buildDashboardDailyMetrics", { enumerable: true, get: function () { return dashboard_runs_js_1.buildDashboardDailyMetrics; } });
Object.defineProperty(exports, "normalizeIdleSummarySnapshotRow", { enumerable: true, get: function () { return dashboard_runs_js_1.normalizeIdleSummarySnapshotRow; } });
const chat_js_1 = require("./chat.js");
const chat_sessions_js_1 = require("../state/chat-sessions.js");
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
const EXECUTION_LEASE_STALE_MS = getPositiveIntegerFromEnv('SIFTKIT_EXECUTION_LEASE_STALE_MS', 10_000);
const IDLE_SUMMARY_DELAY_MS = getPositiveIntegerFromEnv('SIFTKIT_IDLE_SUMMARY_DELAY_MS', 600_000);
const GPU_LOCK_POLL_DELAY_MS = 100;
const LLAMA_STARTUP_GRACE_DELAY_MS = 2_000;
const MANAGED_LLAMA_LOG_ALERT_PATTERN = /\b(?:warn(?:ing)?|error|exception|fatal)\b/iu;
function terminateProcessTree(pid, options = {}) {
    const processObject = options.processObject || process;
    const spawnSyncImpl = options.spawnSyncImpl || node_child_process_1.spawnSync;
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
        }
        catch {
            // Fall back to process.kill below.
        }
    }
    try {
        processObject.kill(Math.trunc(numericPid), 'SIGTERM');
        return true;
    }
    catch {
        return false;
    }
}
function resolveManagedScriptPath(scriptPath, configPath) {
    if (!scriptPath || !scriptPath.trim()) {
        return null;
    }
    return path.isAbsolute(scriptPath)
        ? path.resolve(scriptPath)
        : path.resolve(path.dirname(configPath), scriptPath);
}
function createManagedLlamaLogPaths(purpose) {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const suffix = crypto.randomUUID().slice(0, 8);
    const directory = path.join((0, paths_js_1.getManagedLlamaLogRoot)(), `${timestamp}-${suffix}-${purpose}`);
    (0, http_utils_js_1.ensureDirectory)(path.join(directory, 'placeholder.txt'));
    return {
        directory,
        scriptStdoutPath: path.join(directory, 'script.stdout.log'),
        scriptStderrPath: path.join(directory, 'script.stderr.log'),
        llamaStdoutPath: path.join(directory, 'llama.stdout.log'),
        llamaStderrPath: path.join(directory, 'llama.stderr.log'),
        startupDumpPath: path.join(directory, 'startup-review.log'),
        latestStartupDumpPath: path.join((0, paths_js_1.getManagedLlamaLogRoot)(), 'latest-startup.log'),
        failureDumpPath: path.join(directory, 'startup-scan-failure.log'),
    };
}
function logLine(message, date = new Date()) {
    process.stdout.write(`${(0, formatting_js_1.formatTimestamp)(date)} ${message}\n`);
}
function startStatusServer(options = {}) {
    const disableManagedLlamaStartup = Boolean(options.disableManagedLlamaStartup);
    const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
    const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
    const statusPath = (0, paths_js_1.getStatusPath)();
    const configPath = (0, paths_js_1.getConfigPath)();
    const metricsPath = (0, paths_js_1.getMetricsPath)();
    const idleSummarySnapshotsPath = (0, paths_js_1.getIdleSummarySnapshotsPath)();
    (0, status_file_js_1.ensureStatusFile)(statusPath);
    (0, config_store_js_1.writeConfig)(configPath, (0, config_store_js_1.readConfig)(configPath));
    let metrics = (0, metrics_js_1.readMetrics)(metricsPath);
    (0, metrics_js_1.writeMetrics)(metricsPath, metrics);
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
    let server;
    let resolveStartupPromise = () => { };
    let rejectStartupPromise = () => { };
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
            '-RuntimeRoot', (0, paths_js_1.getRuntimeRoot)(),
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
    function spawnManagedScript(scriptPath, purpose, spawnOptions = {}) {
        const logPaths = spawnOptions.logPaths || createManagedLlamaLogPaths(purpose);
        let invocation;
        try {
            invocation = getManagedScriptInvocation(scriptPath);
        }
        catch {
            throw new Error(`Configured llama.cpp ${purpose} script does not exist: ${scriptPath}`);
        }
        const stdoutFd = fs.openSync(logPaths.scriptStdoutPath, 'w');
        const stderrFd = fs.openSync(logPaths.scriptStderrPath, 'w');
        const child = (0, node_child_process_1.spawn)(invocation.filePath, invocation.args, {
            cwd: invocation.cwd,
            env: {
                ...process.env,
                SIFTKIT_SERVER_CONFIG_PATH: configPath,
                SIFTKIT_SERVER_CONFIG_URL: `${getServiceBaseUrl()}/config`,
                SIFTKIT_SERVER_STATUS_PATH: statusPath,
                SIFTKIT_SERVER_STATUS_URL: `${getServiceBaseUrl()}/status`,
                SIFTKIT_SERVER_HEALTH_URL: `${getServiceBaseUrl()}/health`,
                SIFTKIT_SERVER_RUNTIME_ROOT: (0, paths_js_1.getRuntimeRoot)(),
                SIFTKIT_MANAGED_LLAMA_STARTUP: '1',
                ...(spawnOptions.syncOnly ? { SIFTKIT_MANAGED_LLAMA_SYNC_ONLY: '1' } : {}),
                SIFTKIT_LLAMA_SCRIPT_STDOUT_PATH: logPaths.scriptStdoutPath,
                SIFTKIT_LLAMA_SCRIPT_STDERR_PATH: logPaths.scriptStderrPath,
                SIFTKIT_LLAMA_STDOUT_PATH: logPaths.llamaStdoutPath,
                SIFTKIT_LLAMA_STDERR_PATH: logPaths.llamaStderrPath,
                SIFTKIT_LLAMA_VERBOSE_LOGGING: spawnOptions.managedVerboseLogging ? '1' : '0',
                SIFTKIT_LLAMA_VERBOSE_ARGS_JSON: JSON.stringify(Array.isArray(spawnOptions.managedVerboseArgs) ? spawnOptions.managedVerboseArgs : []),
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
        return { child, logPaths };
    }
    async function syncManagedLlamaConfigFromStartupScriptIfNeeded() {
        const config = (0, config_store_js_1.readConfig)(configPath);
        if (config.Backend !== 'llama.cpp') {
            return;
        }
        const managed = (0, config_store_js_1.getManagedLlamaConfig)(config);
        if (!managed.StartupScript) {
            return;
        }
        logLine(`llama_sync startup_script script=${managed.StartupScript}`);
        const launched = spawnManagedScript(managed.StartupScript, 'startup-sync', {
            syncOnly: true,
            managedVerboseLogging: managed.VerboseLogging,
            managedVerboseArgs: managed.VerboseArgs,
        });
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
            const text = (0, http_utils_js_1.readTextIfExists)(filePath);
            const matchingLines = text
                .split(/\r?\n/u)
                .filter((line) => MANAGED_LLAMA_LOG_ALERT_PATTERN.test(line));
            entries.push({ label, filePath, text, matchingLines });
        }
        return entries;
    }
    function collectManagedLlamaAlertMatches(logPaths) {
        return collectManagedLlamaLogEntries(logPaths)
            .filter((entry) => entry.text.trim() || entry.matchingLines.length > 0);
    }
    function writeManagedLlamaStartupReviewDump(logPaths, dumpOptions = {}) {
        const entries = collectManagedLlamaLogEntries(logPaths);
        const content = [
            'Managed llama.cpp startup log dump.',
            `Result: ${dumpOptions.result || 'unknown'}`,
            ...(dumpOptions.baseUrl ? [`BaseUrl: ${dumpOptions.baseUrl}`] : []),
            ...(dumpOptions.errorMessage ? [`Error: ${dumpOptions.errorMessage}`] : []),
            '',
            'Full logs:',
            ...entries.flatMap((entry) => [
                `===== ${entry.label} :: ${entry.filePath} =====`,
                entry.text.trimEnd() || '<empty>',
                '',
            ]),
        ].join('\n');
        (0, http_utils_js_1.writeText)(logPaths.startupDumpPath, `${content}\n`);
        (0, http_utils_js_1.writeText)(logPaths.latestStartupDumpPath, `${content}\n`);
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
        (0, http_utils_js_1.writeText)(logPaths.failureDumpPath, `${content}\n`);
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
        const baseUrl = (0, config_store_js_1.getLlamaBaseUrl)(config);
        if (!baseUrl) {
            return false;
        }
        try {
            const response = await (0, http_utils_js_1.requestText)(`${baseUrl.replace(/\/$/u, '')}/v1/models`, (0, config_store_js_1.getManagedLlamaConfig)(config).HealthcheckTimeoutMs);
            return response.statusCode > 0 && response.statusCode < 400;
        }
        catch {
            return false;
        }
    }
    async function waitForLlamaServerReachability(config, shouldBeReachable, deadline = null) {
        const managed = (0, config_store_js_1.getManagedLlamaConfig)(config);
        const timeoutDeadline = Number.isFinite(deadline) ? Number(deadline) : Date.now() + managed.StartupTimeoutMs;
        while (Date.now() < timeoutDeadline) {
            const reachable = await isLlamaServerReachable(config);
            if (reachable === shouldBeReachable) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, managed.HealthcheckIntervalMs));
        }
        const baseUrl = (0, config_store_js_1.getLlamaBaseUrl)(config) || '<missing>';
        throw new Error(`Timed out waiting for llama.cpp server at ${baseUrl} to become ${shouldBeReachable ? 'ready' : 'offline'}.`);
    }
    async function abortManagedLlamaStartup(config, launchedChild = null) {
        const managed = (0, config_store_js_1.getManagedLlamaConfig)(config);
        if (managed.ShutdownScript) {
            logLine(`llama_stop startup_abort script=${managed.ShutdownScript}`);
            const stopChild = spawnManagedScript(managed.ShutdownScript, 'shutdown', {
                managedVerboseLogging: managed.VerboseLogging,
                managedVerboseArgs: managed.VerboseArgs,
            }).child;
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
        }
        else if (launchedChild && launchedChild.exitCode === null && launchedChild.signalCode === null) {
            launchedChild.kill('SIGTERM');
        }
        try {
            await waitForLlamaServerReachability(config, false);
        }
        finally {
            managedLlamaReady = false;
            managedLlamaHostProcess = null;
            managedLlamaLastStartupLogs = null;
        }
    }
    function dumpManagedLlamaStartupReviewToConsole(logPaths, stream = process.stderr) {
        if (!logPaths) {
            return;
        }
        const dumpText = (0, http_utils_js_1.readTextIfExists)(logPaths.startupDumpPath) || (0, http_utils_js_1.readTextIfExists)(logPaths.latestStartupDumpPath);
        if (!dumpText.trim()) {
            return;
        }
        stream.write(`${dumpText.trimEnd()}\n`);
    }
    async function ensureManagedLlamaReady(_options = {}) {
        void _options;
        const config = (0, config_store_js_1.readConfig)(configPath);
        if (config.Backend !== 'llama.cpp') {
            return config;
        }
        const baseUrl = (0, config_store_js_1.getLlamaBaseUrl)(config);
        if (!baseUrl) {
            return config;
        }
        const managed = (0, config_store_js_1.getManagedLlamaConfig)(config);
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
            return (0, config_store_js_1.readConfig)(configPath);
        }
        const graceDelayMs = Math.min(LLAMA_STARTUP_GRACE_DELAY_MS, Math.max(startupDeadline - Date.now(), 0));
        if (graceDelayMs > 0) {
            await (0, http_utils_js_1.sleep)(graceDelayMs);
        }
        if (await isLlamaServerReachable(config)) {
            managedLlamaReady = true;
            publishStatus();
            return (0, config_store_js_1.readConfig)(configPath);
        }
        if (managedLlamaStartupPromise) {
            await managedLlamaStartupPromise;
            managedLlamaReady = true;
            publishStatus();
            return (0, config_store_js_1.readConfig)(configPath);
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
            logLine(`llama_start verbose_logging=${managed.VerboseLogging ? 'on' : 'off'} verbose_args=${JSON.stringify(managed.VerboseArgs)}`);
            const launched = spawnManagedScript(managed.StartupScript, 'startup', {
                managedVerboseLogging: managed.VerboseLogging,
                managedVerboseArgs: managed.VerboseArgs,
            });
            managedLlamaHostProcess = launched.child;
            managedLlamaLastStartupLogs = launched.logPaths;
            try {
                await waitForLlamaServerReachability(config, true, startupDeadline);
                await scanManagedLlamaStartupLogsOrFail(launched.logPaths);
                writeManagedLlamaStartupReviewDump(launched.logPaths, { result: 'ready', baseUrl });
                managedLlamaReady = true;
                logLine(`llama_start ready base_url=${baseUrl}`);
            }
            catch (error) {
                writeManagedLlamaStartupReviewDump(launched.logPaths, {
                    result: 'failed',
                    baseUrl,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
                managedLlamaReady = false;
                if (!/startup logs contained warning\/error markers/iu.test(error instanceof Error ? error.message : '')) {
                    try {
                        await abortManagedLlamaStartup(config, launched.child);
                    }
                    catch (cleanupError) {
                        process.stderr.write(`[siftKitStatus] Failed to abort managed llama.cpp startup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
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
        return (0, config_store_js_1.readConfig)(configPath);
    }
    async function shutdownManagedLlamaIfNeeded(shutdownOptions = {}) {
        if (disableManagedLlamaStartup) {
            managedLlamaReady = false;
            releaseSiftKitGpuLockIfIdle();
            return;
        }
        const config = (0, config_store_js_1.readConfig)(configPath);
        if (config.Backend !== 'llama.cpp') {
            return;
        }
        const baseUrl = (0, config_store_js_1.getLlamaBaseUrl)(config);
        if (!baseUrl) {
            return;
        }
        const force = Boolean(shutdownOptions.force);
        const timeoutMs = Number.isFinite(Number(shutdownOptions.timeoutMs)) && Number(shutdownOptions.timeoutMs) > 0
            ? Number(shutdownOptions.timeoutMs)
            : (0, config_store_js_1.getManagedLlamaConfig)(config).StartupTimeoutMs;
        const shutdownDeadline = Date.now() + timeoutMs;
        if (managedLlamaStartupPromise) {
            await managedLlamaStartupPromise;
        }
        if (managedLlamaShutdownPromise) {
            await managedLlamaShutdownPromise;
            return;
        }
        const managed = (0, config_store_js_1.getManagedLlamaConfig)(config);
        const hasActiveHostProcess = Boolean(managedLlamaHostProcess
            && managedLlamaHostProcess.exitCode === null
            && managedLlamaHostProcess.signalCode === null);
        if (!managed.ShutdownScript && !hasActiveHostProcess) {
            managedLlamaReady = false;
            releaseSiftKitGpuLockIfIdle();
            return;
        }
        managedLlamaShutdownPromise = (async () => {
            if (managed.ShutdownScript) {
                logLine(`llama_stop stopping script=${managed.ShutdownScript}`);
                const stopChild = spawnManagedScript(managed.ShutdownScript, 'shutdown', {
                    managedVerboseLogging: managed.VerboseLogging,
                    managedVerboseArgs: managed.VerboseArgs,
                }).child;
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
            }
            else if (hasActiveHostProcess) {
                const hostPid = managedLlamaHostProcess?.pid ?? 0;
                logLine(`llama_stop stopping pid=${hostPid}`);
                terminateProcessTree(hostPid);
            }
            else {
                process.stderr.write('[siftKitStatus] llama.cpp is still reachable but no shutdown script is configured and no managed host process is active.\n');
                return;
            }
            try {
                await waitForLlamaServerReachability(config, false, shutdownDeadline);
            }
            catch (error) {
                if (force && hasActiveHostProcess) {
                    const hostPid = managedLlamaHostProcess?.pid ?? 0;
                    terminateProcessTree(hostPid);
                    return;
                }
                throw error;
            }
            finally {
                managedLlamaReady = false;
                managedLlamaHostProcess = null;
                managedLlamaLastStartupLogs = null;
            }
            logLine(`llama_stop offline base_url=${baseUrl}`);
            releaseSiftKitGpuLockIfIdle();
        })().catch((error) => {
            process.stderr.write(`[siftKitStatus] Failed to stop llama.cpp server: ${error instanceof Error ? error.message : String(error)}\n`);
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
            const config = (0, config_store_js_1.readConfig)(configPath);
            if (config.Backend !== 'llama.cpp') {
                publishStatus();
                return;
            }
            const baseUrl = (0, config_store_js_1.getLlamaBaseUrl)(config);
            if (!baseUrl) {
                publishStatus();
                return;
            }
            const managed = (0, config_store_js_1.getManagedLlamaConfig)(config);
            if (managed.ShutdownScript) {
                const invocation = getManagedScriptInvocation(managed.ShutdownScript);
                const result = (0, node_child_process_1.spawnSync)(invocation.filePath, invocation.args, {
                    cwd: invocation.cwd,
                    env: {
                        ...process.env,
                        SIFTKIT_SERVER_CONFIG_PATH: configPath,
                        SIFTKIT_SERVER_CONFIG_URL: `${getServiceBaseUrl()}/config`,
                        SIFTKIT_SERVER_STATUS_PATH: statusPath,
                        SIFTKIT_SERVER_STATUS_URL: `${getServiceBaseUrl()}/status`,
                        SIFTKIT_SERVER_HEALTH_URL: `${getServiceBaseUrl()}/health`,
                        SIFTKIT_SERVER_RUNTIME_ROOT: (0, paths_js_1.getRuntimeRoot)(),
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
        }
        catch (error) {
            process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during process exit: ${error instanceof Error ? error.message : String(error)}\n`);
            try {
                publishStatus();
            }
            catch {
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
        }
        catch (error) {
            process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during server exit: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        finally {
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
        const config = (0, config_store_js_1.readConfig)(configPath);
        if (config.Backend !== 'llama.cpp') {
            return;
        }
        const baseUrl = (0, config_store_js_1.getLlamaBaseUrl)(config);
        if (!baseUrl || !await isLlamaServerReachable(config)) {
            return;
        }
        const managed = (0, config_store_js_1.getManagedLlamaConfig)(config);
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
        (0, http_utils_js_1.ensureDirectory)(idleSummarySnapshotsPath);
        idleSummaryDatabase = new better_sqlite3_1.default(idleSummarySnapshotsPath);
        (0, idle_summary_js_1.ensureIdleSummarySnapshotsTable)(idleSummaryDatabase);
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
        if (!requestId)
            return null;
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
        logLine((0, dashboard_runs_js_1.buildStatusRequestLogMessage)({
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
        const logsPath = path.join((0, paths_js_1.getRuntimeRoot)(), 'logs');
        const abandonedPath = path.join(logsPath, 'abandoned', `request_abandoned_${runState.requestId}.json`);
        try {
            (0, http_utils_js_1.saveContentAtomically)(abandonedPath, JSON.stringify({
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
        }
        catch {
            // Best-effort — don't fail the incoming request.
        }
    }
    function hasSiftKitGpuDemand() {
        return bootstrapManagedLlamaStartup || managedLlamaStarting || managedLlamaReady || hasActiveRuns() || idleSummaryPending || Boolean(gpuLockAcquisitionPromise);
    }
    function getPublishedStatusText() {
        if (siftKitWaitingForGpuLock) {
            return status_file_js_1.STATUS_LOCK_REQUESTED;
        }
        if (siftKitOwnsGpuLock) {
            return status_file_js_1.STATUS_TRUE;
        }
        const sharedStatus = (0, status_file_js_1.readStatusText)(statusPath);
        return sharedStatus === status_file_js_1.STATUS_FOREIGN_LOCK ? status_file_js_1.STATUS_FOREIGN_LOCK : status_file_js_1.STATUS_FALSE;
    }
    function writePublishedStatus(publishedStatus = getPublishedStatusText()) {
        (0, http_utils_js_1.writeText)(statusPath, disableManagedLlamaStartup ? status_file_js_1.STATUS_TRUE : publishedStatus);
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
                const sharedStatus = (0, status_file_js_1.readStatusText)(statusPath);
                if (sharedStatus === status_file_js_1.STATUS_FALSE || sharedStatus === status_file_js_1.STATUS_TRUE) {
                    siftKitWaitingForGpuLock = false;
                    siftKitOwnsGpuLock = true;
                    publishStatus();
                    return;
                }
                siftKitWaitingForGpuLock = true;
                siftKitOwnsGpuLock = false;
                publishStatus();
                await (0, http_utils_js_1.sleep)(GPU_LOCK_POLL_DELAY_MS);
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
            const snapshot = (0, idle_summary_js_1.buildIdleSummarySnapshot)({
                ...metrics,
                ...pendingIdleSummaryMetadata,
            }, emittedAt);
            try {
                (0, idle_summary_js_1.persistIdleSummarySnapshot)(getIdleSummaryDatabase(), snapshot);
            }
            catch (error) {
                process.stderr.write(`[siftKitStatus] Failed to persist idle summary snapshot to ${idleSummarySnapshotsPath}: ${error instanceof Error ? error.message : String(error)}\n`);
            }
            logLine((0, idle_summary_js_1.buildIdleSummarySnapshotMessage)(snapshot), emittedAt);
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
            await (0, http_utils_js_1.sleep)(25);
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
        const runtimeRoot = (0, paths_js_1.getRuntimeRoot)();
        if (req.method === 'GET' && pathname === '/dashboard/runs') {
            const query = requestUrl.searchParams;
            const search = (query.get('search') || '').trim().toLowerCase();
            const kind = (query.get('kind') || '').trim().toLowerCase();
            const statusFilter = (query.get('status') || '').trim().toLowerCase();
            const runs = (0, dashboard_runs_js_1.loadDashboardRuns)(runtimeRoot).filter((run) => {
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
            (0, http_utils_js_1.sendJson)(res, 200, { runs, total: runs.length });
            return;
        }
        if (req.method === 'GET' && /^\/dashboard\/runs\/[^/]+$/u.test(pathname)) {
            const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/runs\//u, ''));
            const detail = (0, dashboard_runs_js_1.buildDashboardRunDetail)(runtimeRoot, runId);
            if (!detail) {
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Run not found.' });
                return;
            }
            (0, http_utils_js_1.sendJson)(res, 200, detail);
            return;
        }
        if (req.method === 'GET' && pathname === '/dashboard/metrics/timeseries') {
            const days = (0, dashboard_runs_js_1.buildDashboardDailyMetrics)(runtimeRoot, fs.existsSync(idleSummarySnapshotsPath) ? getIdleSummaryDatabase() : null, metrics);
            (0, http_utils_js_1.sendJson)(res, 200, { days });
            return;
        }
        if (req.method === 'GET' && pathname === '/dashboard/metrics/idle-summary') {
            if (!fs.existsSync(idleSummarySnapshotsPath)) {
                (0, http_utils_js_1.sendJson)(res, 200, { latest: null, snapshots: [] });
                return;
            }
            const limitValue = Number(requestUrl.searchParams.get('limit') || 30);
            const limit = Math.max(1, Math.min(200, Number.isFinite(limitValue) ? Math.floor(limitValue) : 30));
            const rows = (0, idle_summary_js_1.queryRecentSnapshots)(getIdleSummaryDatabase(), limit);
            const snapshots = rows
                .map(dashboard_runs_js_1.normalizeIdleSummarySnapshotRow)
                .filter((entry) => entry !== null);
            (0, http_utils_js_1.sendJson)(res, 200, { latest: snapshots[0] || null, snapshots });
            return;
        }
        if (req.method === 'GET' && pathname === '/dashboard/chat/sessions') {
            (0, http_utils_js_1.sendJson)(res, 200, { sessions: (0, chat_sessions_js_1.readChatSessions)(runtimeRoot) });
            return;
        }
        if (req.method === 'GET' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)((0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId));
            if (!session) {
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            (0, http_utils_js_1.sendJson)(res, 200, { session, contextUsage: (0, chat_js_1.buildContextUsage)(session) });
            return;
        }
        if (req.method === 'PUT' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
            const sessionPath = (0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId);
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)(sessionPath);
            if (!session) {
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            const updated = { ...session, updatedAtUtc: new Date().toISOString() };
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
            (0, chat_sessions_js_1.saveChatSession)(runtimeRoot, updated);
            (0, http_utils_js_1.sendJson)(res, 200, { session: updated, contextUsage: (0, chat_js_1.buildContextUsage)(updated) });
            return;
        }
        if (req.method === 'DELETE' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
            const sessionPath = (0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId);
            if (!fs.existsSync(sessionPath)) {
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            try {
                fs.rmSync(sessionPath, { force: true });
            }
            catch (error) {
                (0, http_utils_js_1.sendJson)(res, 500, { error: error instanceof Error ? error.message : String(error) });
                return;
            }
            (0, http_utils_js_1.sendJson)(res, 200, { ok: true, deleted: true, id: sessionId });
            return;
        }
        if (req.method === 'POST' && pathname === '/dashboard/chat/sessions') {
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            const now = new Date().toISOString();
            const currentConfig = (0, config_store_js_1.readConfig)(configPath);
            const runtimeCfg = currentConfig.Runtime ?? {};
            const runtimeLlamaCfg = runtimeCfg.LlamaCpp ?? {};
            const session = {
                id: crypto.randomUUID(),
                title: typeof parsedBody.title === 'string' && parsedBody.title.trim() ? parsedBody.title.trim() : 'New Session',
                model: typeof parsedBody.model === 'string' && parsedBody.model.trim()
                    ? parsedBody.model.trim()
                    : runtimeCfg.Model || null,
                contextWindowTokens: Number(runtimeLlamaCfg.NumCtx || 150000),
                thinkingEnabled: runtimeLlamaCfg.Reasoning !== 'off',
                mode: 'chat',
                planRepoRoot: process.cwd(),
                condensedSummary: '',
                createdAtUtc: now,
                updatedAtUtc: now,
                messages: [],
                hiddenToolContexts: [],
            };
            (0, chat_sessions_js_1.saveChatSession)(runtimeRoot, session);
            (0, http_utils_js_1.sendJson)(res, 200, { session, contextUsage: (0, chat_js_1.buildContextUsage)(session) });
            return;
        }
        if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages$/u.test(pathname)) {
            const modelRequestLock = await acquireModelRequestWithWait('dashboard_chat');
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages$/u, ''));
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)((0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId));
            if (!session) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected content.' });
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
                }
                else {
                    const config = (0, config_store_js_1.readConfig)(configPath);
                    const generated = await (0, chat_js_1.generateChatAssistantMessage)(config, session, userContent);
                    assistantContent = generated.assistantContent;
                    usage = generated.usage;
                    thinkingContent = generated.thinkingContent || '';
                }
                const updatedSession = (0, chat_js_1.appendChatMessagesWithUsage)(runtimeRoot, session, userContent, assistantContent, usage, thinkingContent);
                (0, http_utils_js_1.sendJson)(res, 200, { session: updatedSession, contextUsage: (0, chat_js_1.buildContextUsage)(updatedSession) });
            }
            catch (error) {
                (0, http_utils_js_1.sendJson)(res, 500, { error: error instanceof Error ? error.message : String(error) });
            }
            finally {
                releaseModelRequest(modelRequestLock.token);
            }
            return;
        }
        if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan$/u.test(pathname)) {
            const modelRequestLock = await acquireModelRequestWithWait('dashboard_plan');
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan$/u, ''));
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)((0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId));
            if (!session) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected content.' });
                return;
            }
            const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim()
                ? parsedBody.repoRoot.trim()
                : (typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim() ? session.planRepoRoot.trim() : process.cwd());
            const resolvedRepoRoot = path.resolve(requestedRepoRoot);
            if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected existing repoRoot directory.' });
                return;
            }
            try {
                const executeRepoSearchRequest = (0, chat_js_1.loadRepoSearchExecutor)();
                const content = parsedBody.content.trim();
                const result = await executeRepoSearchRequest({
                    prompt: (0, chat_js_1.buildPlanRequestPrompt)(content),
                    repoRoot: resolvedRepoRoot,
                    config: (0, config_store_js_1.readConfig)(configPath),
                    model: typeof parsedBody.model === 'string' && parsedBody.model.trim() ? parsedBody.model.trim() : undefined,
                    requestMaxTokens: 10000,
                    maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
                    thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
                    logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim() ? parsedBody.logFile.trim() : undefined,
                    availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((v) => String(v)) : undefined,
                    mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((v) => String(v)) : undefined,
                    mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
                    onProgress(event) {
                        if (event.kind === 'tool_start') {
                            const logMessage = (0, dashboard_runs_js_1.buildRepoSearchProgressLogMessage)(event, 'planner');
                            if (logMessage)
                                logLine(logMessage);
                        }
                    },
                });
                const assistantContent = (0, chat_js_1.buildPlanMarkdownFromRepoSearch)(content, resolvedRepoRoot, result);
                const toolContextContents = (0, chat_js_1.buildToolContextFromRepoSearchResult)(result);
                const updatedSession = (0, chat_js_1.appendChatMessagesWithUsage)(runtimeRoot, { ...session, mode: 'plan', planRepoRoot: resolvedRepoRoot }, content, assistantContent, {
                    promptTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptTokens'),
                    promptCacheTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptCacheTokens'),
                    promptEvalTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptEvalTokens'),
                }, '', { toolContextContents });
                (0, http_utils_js_1.sendJson)(res, 200, {
                    session: updatedSession,
                    contextUsage: (0, chat_js_1.buildContextUsage)(updatedSession),
                    repoSearch: {
                        requestId: result.requestId,
                        transcriptPath: result.transcriptPath,
                        artifactPath: result.artifactPath,
                        scorecard: result.scorecard,
                    },
                });
            }
            catch (error) {
                (0, http_utils_js_1.sendJson)(res, 500, { error: error instanceof Error ? error.message : String(error) });
            }
            finally {
                releaseModelRequest(modelRequestLock.token);
            }
            return;
        }
        if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan\/stream$/u.test(pathname)) {
            const modelRequestLock = await acquireModelRequestWithWait('dashboard_plan_stream');
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan\/stream$/u, ''));
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)((0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId));
            if (!session) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected content.' });
                return;
            }
            const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim()
                ? parsedBody.repoRoot.trim()
                : (typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim() ? session.planRepoRoot.trim() : process.cwd());
            const resolvedRepoRoot = path.resolve(requestedRepoRoot);
            if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected existing repoRoot directory.' });
                return;
            }
            let clientDisconnected = false;
            req.on('close', () => { clientDisconnected = true; });
            const writeSse = (eventName, payload) => {
                if (clientDisconnected)
                    return;
                try {
                    res.write(`event: ${eventName}\n`);
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                }
                catch { /* client gone */ }
            };
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.write('\n');
            try {
                const executeRepoSearchRequest = (0, chat_js_1.loadRepoSearchExecutor)();
                const content = parsedBody.content.trim();
                const result = await executeRepoSearchRequest({
                    prompt: (0, chat_js_1.buildPlanRequestPrompt)(content),
                    repoRoot: resolvedRepoRoot,
                    config: (0, config_store_js_1.readConfig)(configPath),
                    model: typeof parsedBody.model === 'string' && parsedBody.model.trim() ? parsedBody.model.trim() : undefined,
                    requestMaxTokens: 10000,
                    maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
                    thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
                    logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim() ? parsedBody.logFile.trim() : undefined,
                    availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((v) => String(v)) : undefined,
                    mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((v) => String(v)) : undefined,
                    mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
                    onProgress(event) {
                        if (event.kind === 'tool_start') {
                            const logMessage = (0, dashboard_runs_js_1.buildRepoSearchProgressLogMessage)(event, 'planner');
                            if (logMessage)
                                logLine(logMessage);
                        }
                        if (event.kind === 'thinking') {
                            writeSse('thinking', { thinking: event.thinkingText || '' });
                        }
                        else if (event.kind === 'tool_start') {
                            writeSse('tool_start', {
                                turn: event.turn,
                                maxTurns: event.maxTurns,
                                command: event.command,
                                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
                            });
                            writeSse('answer', { answer: `Planning step ${event.turn}/${event.maxTurns}: running \`${event.command}\`...` });
                        }
                        else if (event.kind === 'tool_result') {
                            writeSse('tool_result', {
                                turn: event.turn,
                                maxTurns: event.maxTurns,
                                command: event.command,
                                exitCode: event.exitCode,
                                outputSnippet: event.outputSnippet,
                                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
                            });
                            writeSse('answer', { answer: `Planning step ${event.turn}/${event.maxTurns}: \`${event.command}\` finished (exit ${event.exitCode ?? '?'})` });
                        }
                    },
                });
                const assistantContent = (0, chat_js_1.buildPlanMarkdownFromRepoSearch)(content, resolvedRepoRoot, result);
                const toolContextContents = (0, chat_js_1.buildToolContextFromRepoSearchResult)(result);
                const updatedSession = (0, chat_js_1.appendChatMessagesWithUsage)(runtimeRoot, { ...session, mode: 'plan', planRepoRoot: resolvedRepoRoot }, content, assistantContent, {
                    promptTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptTokens'),
                    promptCacheTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptCacheTokens'),
                    promptEvalTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptEvalTokens'),
                }, '', { toolContextContents });
                writeSse('done', {
                    session: updatedSession,
                    contextUsage: (0, chat_js_1.buildContextUsage)(updatedSession),
                    repoSearch: {
                        requestId: result.requestId,
                        transcriptPath: result.transcriptPath,
                        artifactPath: result.artifactPath,
                        scorecard: result.scorecard,
                    },
                });
            }
            catch (error) {
                writeSse('error', { error: error instanceof Error ? error.message : String(error) });
            }
            finally {
                releaseModelRequest(modelRequestLock.token);
                res.end();
            }
            return;
        }
        if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/repo-search\/stream$/u.test(pathname)) {
            const modelRequestLock = await acquireModelRequestWithWait('dashboard_repo_search_stream');
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/stream$/u, ''));
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)((0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId));
            if (!session) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected content.' });
                return;
            }
            const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim()
                ? parsedBody.repoRoot.trim()
                : (typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim() ? session.planRepoRoot.trim() : process.cwd());
            const resolvedRepoRoot = path.resolve(requestedRepoRoot);
            if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected existing repoRoot directory.' });
                return;
            }
            let clientDisconnected = false;
            req.on('close', () => { clientDisconnected = true; });
            const writeSse = (eventName, payload) => {
                if (clientDisconnected)
                    return;
                try {
                    res.write(`event: ${eventName}\n`);
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                }
                catch { /* client gone */ }
            };
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.write('\n');
            try {
                const executeRepoSearchRequest = (0, chat_js_1.loadRepoSearchExecutor)();
                const content = parsedBody.content.trim();
                const result = await executeRepoSearchRequest({
                    prompt: content,
                    repoRoot: resolvedRepoRoot,
                    config: (0, config_store_js_1.readConfig)(configPath),
                    model: typeof parsedBody.model === 'string' && parsedBody.model.trim() ? parsedBody.model.trim() : undefined,
                    requestMaxTokens: 10000,
                    maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
                    thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
                    logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim() ? parsedBody.logFile.trim() : undefined,
                    availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((v) => String(v)) : undefined,
                    mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((v) => String(v)) : undefined,
                    mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
                    onProgress(event) {
                        if (event.kind === 'tool_start') {
                            const logMessage = (0, dashboard_runs_js_1.buildRepoSearchProgressLogMessage)(event, 'repo_search');
                            if (logMessage)
                                logLine(logMessage);
                        }
                        if (event.kind === 'thinking') {
                            writeSse('thinking', { thinking: event.thinkingText || '' });
                        }
                        else if (event.kind === 'tool_start') {
                            writeSse('tool_start', {
                                turn: event.turn,
                                maxTurns: event.maxTurns,
                                command: event.command,
                                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
                            });
                            writeSse('answer', { answer: `Search step ${event.turn}/${event.maxTurns}: running \`${event.command}\`...` });
                        }
                        else if (event.kind === 'tool_result') {
                            writeSse('tool_result', {
                                turn: event.turn,
                                maxTurns: event.maxTurns,
                                command: event.command,
                                exitCode: event.exitCode,
                                outputSnippet: event.outputSnippet,
                                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
                            });
                            writeSse('answer', { answer: `Search step ${event.turn}/${event.maxTurns}: \`${event.command}\` finished (exit ${event.exitCode ?? '?'})` });
                        }
                    },
                });
                const assistantContent = (0, chat_js_1.buildRepoSearchMarkdown)(content, resolvedRepoRoot, result);
                const toolContextContents = (0, chat_js_1.buildToolContextFromRepoSearchResult)(result);
                const updatedSession = (0, chat_js_1.appendChatMessagesWithUsage)(runtimeRoot, { ...session, mode: 'repo-search', planRepoRoot: resolvedRepoRoot }, content, assistantContent, {
                    promptTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptTokens'),
                    promptCacheTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptCacheTokens'),
                    promptEvalTokens: (0, chat_js_1.getScorecardTotal)(result?.scorecard, 'promptEvalTokens'),
                }, '', { toolContextContents });
                writeSse('done', {
                    session: updatedSession,
                    contextUsage: (0, chat_js_1.buildContextUsage)(updatedSession),
                    repoSearch: {
                        requestId: result.requestId,
                        transcriptPath: result.transcriptPath,
                        artifactPath: result.artifactPath,
                        scorecard: result.scorecard,
                    },
                });
            }
            catch (error) {
                writeSse('error', { error: error instanceof Error ? error.message : String(error) });
            }
            finally {
                releaseModelRequest(modelRequestLock.token);
                res.end();
            }
            return;
        }
        if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/tool-context\/clear$/u.test(pathname)) {
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/tool-context\/clear$/u, ''));
            const sessionPath = (0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId);
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)(sessionPath);
            if (!session) {
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            const updatedSession = {
                ...session,
                updatedAtUtc: new Date().toISOString(),
                hiddenToolContexts: [],
            };
            (0, chat_sessions_js_1.saveChatSession)(runtimeRoot, updatedSession);
            (0, http_utils_js_1.sendJson)(res, 200, { session: updatedSession, contextUsage: (0, chat_js_1.buildContextUsage)(updatedSession) });
            return;
        }
        if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages\/stream$/u.test(pathname)) {
            const modelRequestLock = await acquireModelRequestWithWait('dashboard_chat');
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages\/stream$/u, ''));
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)((0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId));
            if (!session) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.content !== 'string' || !parsedBody.content.trim()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected content.' });
                return;
            }
            const writeSse = (eventName, payload) => {
                res.write(`event: ${eventName}\n`);
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
            };
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.write('\n');
            try {
                const userContent = parsedBody.content.trim();
                const config = (0, config_store_js_1.readConfig)(configPath);
                const generated = await (0, chat_js_1.streamChatAssistantMessage)(config, session, userContent, (progress) => {
                    writeSse('thinking', { thinking: progress.thinkingContent });
                    writeSse('answer', { answer: progress.assistantContent });
                });
                const updatedSession = (0, chat_js_1.appendChatMessagesWithUsage)(runtimeRoot, session, userContent, generated.assistantContent, generated.usage, generated.thinkingContent);
                writeSse('done', { session: updatedSession, contextUsage: (0, chat_js_1.buildContextUsage)(updatedSession) });
            }
            catch (error) {
                writeSse('error', { error: error instanceof Error ? error.message : String(error) });
            }
            finally {
                releaseModelRequest(modelRequestLock.token);
                res.end();
            }
            return;
        }
        if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/condense$/u.test(pathname)) {
            const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/condense$/u, ''));
            const session = (0, chat_sessions_js_1.readChatSessionFromPath)((0, chat_sessions_js_1.getChatSessionPath)(runtimeRoot, sessionId));
            if (!session) {
                (0, http_utils_js_1.sendJson)(res, 404, { error: 'Session not found.' });
                return;
            }
            const updatedSession = (0, chat_js_1.condenseChatSession)(runtimeRoot, session);
            (0, http_utils_js_1.sendJson)(res, 200, { session: updatedSession, contextUsage: (0, chat_js_1.buildContextUsage)(updatedSession) });
            return;
        }
        if (req.method === 'GET' && req.url === '/health') {
            (0, http_utils_js_1.sendJson)(res, 200, {
                ok: true,
                disableManagedLlamaStartup,
                statusPath,
                configPath,
                metricsPath,
                idleSummarySnapshotsPath,
                runtimeRoot: (0, paths_js_1.getRuntimeRoot)(),
            });
            return;
        }
        if (req.method === 'GET' && req.url === '/status') {
            const currentStatus = getPublishedStatusText();
            (0, http_utils_js_1.sendJson)(res, 200, { running: currentStatus === status_file_js_1.STATUS_TRUE, status: currentStatus, statusPath, configPath, metrics, idleSummarySnapshotsPath });
            return;
        }
        if (req.method === 'GET' && req.url === '/execution') {
            const lease = getActiveExecutionLease();
            (0, http_utils_js_1.sendJson)(res, 200, { busy: Boolean(lease), statusPath, configPath });
            return;
        }
        if (req.method === 'POST' && req.url === '/execution/acquire') {
            clearIdleSummaryTimer();
            const lease = getActiveExecutionLease();
            if (lease) {
                (0, http_utils_js_1.sendJson)(res, 200, { ok: true, acquired: false, busy: true });
                return;
            }
            const token = crypto.randomUUID();
            activeExecutionLease = { token, heartbeatAt: Date.now() };
            (0, http_utils_js_1.sendJson)(res, 200, { ok: true, acquired: true, busy: true, token });
            return;
        }
        if (req.method === 'POST' && req.url === '/execution/heartbeat') {
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.token !== 'string' || !parsedBody.token.trim()) {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected token.' });
                return;
            }
            const lease = getActiveExecutionLease();
            if (!lease || lease.token !== parsedBody.token) {
                (0, http_utils_js_1.sendJson)(res, 409, { error: 'Execution lease is not active.' });
                return;
            }
            lease.heartbeatAt = Date.now();
            (0, http_utils_js_1.sendJson)(res, 200, { ok: true, busy: true });
            return;
        }
        if (req.method === 'POST' && req.url === '/execution/release') {
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.token !== 'string' || !parsedBody.token.trim()) {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected token.' });
                return;
            }
            const released = releaseExecutionLease(parsedBody.token);
            (0, http_utils_js_1.sendJson)(res, released ? 200 : 409, { ok: released, released, busy: Boolean(getActiveExecutionLease()) });
            return;
        }
        if (req.method === 'POST' && req.url === '/repo-search') {
            const modelRequestLock = await acquireModelRequestWithWait('repo_search');
            let parsedBody;
            try {
                parsedBody = (0, http_utils_js_1.parseJsonBody)(await (0, http_utils_js_1.readBody)(req));
            }
            catch {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            if (typeof parsedBody.prompt !== 'string' || !parsedBody.prompt.trim()) {
                releaseModelRequest(modelRequestLock.token);
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected prompt.' });
                return;
            }
            if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
                await (0, http_utils_js_1.sleep)(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
            }
            try {
                const executeRepoSearchRequest = (0, chat_js_1.loadRepoSearchExecutor)();
                const result = await executeRepoSearchRequest({
                    prompt: parsedBody.prompt,
                    repoRoot: typeof parsedBody.repoRoot === 'string' && parsedBody.repoRoot.trim() ? parsedBody.repoRoot.trim() : process.cwd(),
                    statusBackendUrl: `${getServiceBaseUrl()}/status`,
                    config: (0, config_store_js_1.readConfig)(configPath),
                    model: typeof parsedBody.model === 'string' && parsedBody.model.trim() ? parsedBody.model.trim() : undefined,
                    maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
                    thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
                    logFile: typeof parsedBody.logFile === 'string' && parsedBody.logFile.trim() ? parsedBody.logFile.trim() : undefined,
                    availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((v) => String(v)) : undefined,
                    mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((v) => String(v)) : undefined,
                    mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
                    onProgress(event) {
                        if (event.kind === 'tool_start') {
                            const logMessage = (0, dashboard_runs_js_1.buildRepoSearchProgressLogMessage)(event, 'repo_search');
                            if (logMessage)
                                logLine(logMessage);
                        }
                    },
                });
                (0, http_utils_js_1.sendJson)(res, 200, result);
            }
            catch (error) {
                (0, http_utils_js_1.sendJson)(res, 500, { error: error instanceof Error ? error.message : String(error) });
            }
            finally {
                releaseModelRequest(modelRequestLock.token);
            }
            return;
        }
        if (req.method === 'POST' && req.url === '/status') {
            const bodyText = await (0, http_utils_js_1.readBody)(req);
            const running = (0, status_file_js_1.parseRunning)(bodyText);
            if (running === null) {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected running=true|false or status=true|false.' });
                return;
            }
            const metadata = (0, status_file_js_1.parseStatusMetadata)(bodyText);
            if (metadata.artifactType !== null) {
                if (!metadata.artifactRequestId) {
                    (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected artifactRequestId when artifactType is provided.' });
                    return;
                }
                if (!metadata.artifactPayload) {
                    (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected artifactPayload object when artifactType is provided.' });
                    return;
                }
                const artifactPath = (0, dashboard_runs_js_1.getStatusArtifactPath)(metadata);
                if (!artifactPath) {
                    (0, http_utils_js_1.sendJson)(res, 400, { error: 'Unsupported artifactType.' });
                    return;
                }
                try {
                    (0, http_utils_js_1.saveContentAtomically)(artifactPath, `${JSON.stringify(metadata.artifactPayload, null, 2)}\n`);
                }
                catch (error) {
                    (0, http_utils_js_1.sendJson)(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
                && metadata.promptCacheTokens === null
                && metadata.promptEvalTokens === null
                && metadata.requestDurationMs === null;
            if (isArtifactOnlyPost) {
                const publishedStatus = getPublishedStatusText();
                (0, http_utils_js_1.sendJson)(res, 200, { ok: true, running: publishedStatus === status_file_js_1.STATUS_TRUE, status: publishedStatus, statusPath, configPath });
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
                const activeRun = activeRequestId ? activeRunsByRequestId.get(activeRequestId) || null : null;
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
                }
                else {
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
            }
            else {
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
                    }
                    else if (metadata.terminalState === 'failed') {
                        totalElapsedMs = now - runState.overallStartedAt;
                        clearRunState(requestId);
                    }
                }
                metrics = (0, metrics_js_1.normalizeMetrics)({
                    ...metrics,
                    inputCharactersTotal: metrics.inputCharactersTotal + (metadata.promptCharacterCount ?? 0),
                    outputCharactersTotal: metrics.outputCharactersTotal + (metadata.outputCharacterCount ?? 0),
                    inputTokensTotal: metrics.inputTokensTotal + (metadata.inputTokens ?? 0),
                    outputTokensTotal: metrics.outputTokensTotal + (metadata.outputTokens ?? 0),
                    thinkingTokensTotal: metrics.thinkingTokensTotal + (metadata.thinkingTokens ?? 0),
                    promptCacheTokensTotal: metrics.promptCacheTokensTotal + (metadata.promptCacheTokens ?? 0),
                    promptEvalTokensTotal: metrics.promptEvalTokensTotal + (metadata.promptEvalTokens ?? 0),
                    requestDurationMsTotal: metrics.requestDurationMsTotal + (metadata.requestDurationMs
                        ?? (metadata.terminalState ? 0 : (elapsedMs ?? 0))),
                    completedRequestCount: metrics.completedRequestCount + (requestCompleted ? 1 : 0),
                    updatedAtUtc: new Date().toISOString(),
                });
                (0, metrics_js_1.writeMetrics)(metricsPath, metrics);
                if (requestCompleted) {
                    idleSummaryPending = true;
                    scheduleIdleSummaryIfNeeded();
                }
            }
            const logMessage = (0, dashboard_runs_js_1.buildStatusRequestLogMessage)({
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
                totalOutputTokens: metadata.totalOutputTokens ?? null,
            });
            if (!suppressLogLine) {
                logLine(logMessage);
            }
            const publishedStatus = getPublishedStatusText();
            writePublishedStatus(publishedStatus);
            (0, http_utils_js_1.sendJson)(res, 200, { ok: true, running: publishedStatus === status_file_js_1.STATUS_TRUE, status: publishedStatus, statusPath, configPath });
            return;
        }
        if (req.method === 'GET' && req.url === '/config') {
            try {
                if (disableManagedLlamaStartup) {
                    (0, http_utils_js_1.sendJson)(res, 200, (0, config_store_js_1.readConfig)(configPath));
                    return;
                }
                if (bootstrapManagedLlamaStartup && (managedLlamaStarting || managedLlamaStartupPromise)) {
                    (0, http_utils_js_1.sendJson)(res, 200, (0, config_store_js_1.readConfig)(configPath));
                    return;
                }
                (0, http_utils_js_1.sendJson)(res, 200, await ensureManagedLlamaReady());
            }
            catch (error) {
                (0, http_utils_js_1.sendJson)(res, 503, { error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        if (req.method === 'PUT' && req.url === '/config') {
            let parsedBody;
            try {
                parsedBody = JSON.parse(await (0, http_utils_js_1.readBody)(req) || '{}');
            }
            catch {
                (0, http_utils_js_1.sendJson)(res, 400, { error: 'Expected valid JSON object.' });
                return;
            }
            const nextConfig = (0, config_store_js_1.normalizeConfig)((0, config_store_js_1.mergeConfig)((0, config_store_js_1.readConfig)(configPath), parsedBody));
            (0, config_store_js_1.writeConfig)(configPath, nextConfig);
            (0, http_utils_js_1.sendJson)(res, 200, nextConfig);
            return;
        }
        (0, http_utils_js_1.sendJson)(res, 404, { error: 'Not found' });
    });
    const originalClose = server.close.bind(server);
    let closeRequested = false;
    server.close = ((callback) => {
        const finalCallback = typeof callback === 'function' ? callback : undefined;
        if (closeRequested) {
            return originalClose(finalCallback);
        }
        closeRequested = true;
        void shutdownManagedLlamaForServerExit().finally(() => {
            originalClose(finalCallback);
        });
        return server;
    });
    server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, async () => {
        try {
            if (!disableManagedLlamaStartup) {
                await syncManagedLlamaConfigFromStartupScriptIfNeeded();
                await clearPreexistingManagedLlamaIfNeeded();
                bootstrapManagedLlamaStartup = true;
                try {
                    await ensureManagedLlamaReady({ resetStatusBeforeCheck: false });
                }
                finally {
                    bootstrapManagedLlamaStartup = false;
                }
            }
            publishStatus();
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : requestedPort;
            process.stdout.write(`${JSON.stringify({ ok: true, port, host, statusPath, configPath })}\n`);
            resolveStartupPromise();
        }
        catch (error) {
            rejectStartupPromise(error);
            dumpManagedLlamaStartupReviewToConsole(managedLlamaLastStartupLogs);
            process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
        }
        finally {
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
