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
exports.readMatrixManifest = readMatrixManifest;
exports.buildLaunchSignature = buildLaunchSignature;
exports.buildLauncherArgs = buildLauncherArgs;
exports.buildBenchmarkArgs = buildBenchmarkArgs;
exports.runMatrixWithInterrupt = runMatrixWithInterrupt;
exports.runMatrix = runMatrix;
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
class MatrixInterruptedError extends Error {
    constructor(signal) {
        super(`Benchmark matrix interrupted by ${signal}.`);
        this.name = 'MatrixInterruptedError';
    }
}
const repoRoot = path.resolve(__dirname, '..');
const defaultManifestPath = path.join(repoRoot, 'eval', 'benchmark-matrices', 'ai_core_60_tests.6run.json');
const powerShellExe = process.env.ComSpec?.toLowerCase().includes('cmd.exe')
    ? 'powershell.exe'
    : 'powershell.exe';
const nodeExe = process.execPath;
function parseJsonText(text) {
    const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
function readJsonFile(filePath) {
    return parseJsonText(fs.readFileSync(filePath, 'utf8'));
}
function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}
function writeJsonFile(filePath, value) {
    ensureDirectory(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function readTrimmedFileText(filePath) {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim();
}
function getUtcTimestamp() {
    const current = new Date();
    const yyyy = current.getUTCFullYear();
    const MM = String(current.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(current.getUTCDate()).padStart(2, '0');
    const hh = String(current.getUTCHours()).padStart(2, '0');
    const mm = String(current.getUTCMinutes()).padStart(2, '0');
    const ss = String(current.getUTCSeconds()).padStart(2, '0');
    const fff = String(current.getUTCMilliseconds()).padStart(3, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}
function resolvePathFromBase(targetPath, baseDirectory) {
    if (!targetPath.trim()) {
        throw new Error('Path value cannot be empty.');
    }
    return path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(baseDirectory, targetPath);
}
function resolveOptionalPathFromBase(targetPath, baseDirectory) {
    if (targetPath === null || targetPath === undefined || !String(targetPath).trim()) {
        return null;
    }
    return resolvePathFromBase(String(targetPath).trim(), baseDirectory);
}
function resolveModelPathForStartScript(modelPath, startScriptPath) {
    return path.isAbsolute(modelPath)
        ? path.resolve(modelPath)
        : path.resolve(path.dirname(startScriptPath), modelPath);
}
function getRequiredString(value, name) {
    const text = String(value ?? '').trim();
    if (!text) {
        throw new Error(`Manifest field '${name}' is required.`);
    }
    return text;
}
function getRequiredInt(value, name) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`Manifest field '${name}' must be an integer.`);
    }
    return parsed;
}
function getRequiredDouble(value, name) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Manifest field '${name}' must be numeric.`);
    }
    return parsed;
}
function getOptionalInt(value, name) {
    if (value === null || value === undefined || String(value).trim() === '') {
        return null;
    }
    return getRequiredInt(value, name);
}
function getOptionalPositiveInt(value, name) {
    const parsed = getOptionalInt(value, name);
    if (parsed === null) {
        return null;
    }
    if (parsed <= 0) {
        throw new Error(`Manifest field '${name}' must be greater than zero.`);
    }
    return parsed;
}
function getOptionalBoolean(value, name) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`Manifest field '${name}' must be boolean.`);
    }
    return value;
}
function parseArguments(argv) {
    const parsed = {
        manifestPath: defaultManifestPath,
        runIds: [],
        promptPrefixFile: null,
        requestTimeoutSeconds: null,
        validateOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        switch (token) {
            case '--manifest':
            case '--manifest-path':
                parsed.manifestPath = argv[++index];
                break;
            case '--run-id':
                parsed.runIds.push(argv[++index]);
                break;
            case '--prompt-prefix-file':
                parsed.promptPrefixFile = argv[++index];
                break;
            case '--request-timeout-seconds':
                parsed.requestTimeoutSeconds = getOptionalPositiveInt(argv[++index], 'requestTimeoutSeconds');
                break;
            case '--validate-only':
                parsed.validateOnly = true;
                break;
            default:
                throw new Error(`Unknown argument: ${token}`);
        }
    }
    return parsed;
}
function getSelectedRuns(enabledRuns, requestedRunIds) {
    if (requestedRunIds.length === 0) {
        return [...enabledRuns];
    }
    const requested = new Set(requestedRunIds.map((item) => item.trim().toLowerCase()).filter(Boolean));
    const selected = enabledRuns.filter((run) => requested.has(run.id.toLowerCase()));
    const selectedIds = new Set(selected.map((run) => run.id.toLowerCase()));
    const missing = [...requested].filter((runId) => !selectedIds.has(runId));
    if (missing.length > 0) {
        throw new Error(`Requested run ids were not found among enabled manifest runs: ${missing.join(', ')}`);
    }
    return selected;
}
function readMatrixManifest(options) {
    const resolvedManifestPath = resolvePathFromBase(options.manifestPath, repoRoot);
    if (!fs.existsSync(resolvedManifestPath)) {
        throw new Error(`Manifest file not found: ${resolvedManifestPath}`);
    }
    const raw = readJsonFile(resolvedManifestPath);
    const manifestDirectory = path.dirname(resolvedManifestPath);
    const fixtureRoot = resolvePathFromBase(getRequiredString(raw.fixtureRoot, 'fixtureRoot'), manifestDirectory);
    const startScript = resolvePathFromBase(getRequiredString(raw.startScript, 'startScript'), manifestDirectory);
    const stopScript = resolveOptionalPathFromBase(raw.stopScript ?? null, manifestDirectory);
    const resultsRoot = resolvePathFromBase(getRequiredString(raw.resultsRoot, 'resultsRoot'), manifestDirectory);
    const configUrl = getRequiredString(raw.configUrl, 'configUrl');
    const manifestPromptPrefixFile = resolveOptionalPathFromBase(raw.promptPrefixFile ?? null, manifestDirectory);
    const requestTimeoutSeconds = options.requestTimeoutSeconds
        ?? getOptionalPositiveInt(raw.requestTimeoutSeconds ?? null, 'requestTimeoutSeconds')
        ?? 600;
    if (!fs.existsSync(fixtureRoot)) {
        throw new Error(`Fixture root does not exist: ${fixtureRoot}`);
    }
    if (!fs.existsSync(path.join(fixtureRoot, 'fixtures.json'))) {
        throw new Error(`Fixture root is missing fixtures.json: ${fixtureRoot}`);
    }
    if (!fs.existsSync(startScript)) {
        throw new Error(`Start script does not exist: ${startScript}`);
    }
    if (stopScript && !fs.existsSync(stopScript)) {
        throw new Error(`Stop script does not exist: ${stopScript}`);
    }
    if (manifestPromptPrefixFile && !fs.existsSync(manifestPromptPrefixFile)) {
        throw new Error(`Prompt prefix file does not exist: ${manifestPromptPrefixFile}`);
    }
    if (!raw.baseline) {
        throw new Error("Manifest field 'baseline' is required.");
    }
    const baselineModelId = getRequiredString(raw.baseline.modelId, 'baseline.modelId');
    const baselineModelPath = getRequiredString(raw.baseline.modelPath, 'baseline.modelPath');
    const baselineReasoning = getRequiredString(raw.baseline.reasoning, 'baseline.reasoning');
    if (baselineReasoning !== 'off') {
        throw new Error("Manifest baseline.reasoning must be 'off'.");
    }
    const baseline = {
        index: 0,
        id: 'baseline',
        label: 'baseline',
        modelId: baselineModelId,
        modelPath: baselineModelPath,
        startScript,
        resolvedModelPath: resolveModelPathForStartScript(baselineModelPath, startScript),
        promptPrefixFile: null,
        sampling: null,
        contextSize: getRequiredInt(raw.baseline.contextSize, 'baseline.contextSize'),
        maxTokens: getRequiredInt(raw.baseline.maxTokens, 'baseline.maxTokens'),
        reasoning: baselineReasoning,
        passReasoningArg: getOptionalBoolean(raw.baseline.passReasoningArg, 'baseline.passReasoningArg') ?? true,
    };
    if (!fs.existsSync(baseline.resolvedModelPath)) {
        throw new Error(`Baseline model file does not exist: ${baseline.resolvedModelPath}`);
    }
    if (!Array.isArray(raw.runs)) {
        throw new Error("Manifest field 'runs' is required.");
    }
    const enabledRuns = [];
    const idSet = new Set();
    for (const rawRun of raw.runs) {
        const runId = getRequiredString(rawRun.id, 'runs[].id');
        const normalizedId = runId.toLowerCase();
        if (idSet.has(normalizedId)) {
            throw new Error(`Duplicate run id found in manifest: ${runId}`);
        }
        idSet.add(normalizedId);
        if (!rawRun.sampling) {
            throw new Error(`Run '${runId}' is missing its sampling block.`);
        }
        const run = {
            index: getRequiredInt(rawRun.index, `runs[${runId}].index`),
            id: runId,
            label: getRequiredString(rawRun.label, `runs[${runId}].label`),
            modelId: getRequiredString(rawRun.modelId, `runs[${runId}].modelId`),
            modelPath: getRequiredString(rawRun.modelPath, `runs[${runId}].modelPath`),
            startScript: resolveOptionalPathFromBase(rawRun.startScript ?? null, manifestDirectory) ?? startScript,
            resolvedModelPath: '',
            promptPrefixFile: resolveOptionalPathFromBase(rawRun.promptPrefixFile ?? null, manifestDirectory),
            reasoning: (rawRun.reasoning ?? baseline.reasoning),
            contextSize: getOptionalInt(rawRun.contextSize, `runs[${runId}].contextSize`) ?? baseline.contextSize,
            maxTokens: getOptionalInt(rawRun.maxTokens, `runs[${runId}].maxTokens`) ?? baseline.maxTokens,
            passReasoningArg: getOptionalBoolean(rawRun.passReasoningArg, `runs[${runId}].passReasoningArg`) ?? baseline.passReasoningArg,
            sampling: {
                temperature: getRequiredDouble(rawRun.sampling.temperature, `runs[${runId}].sampling.temperature`),
                topP: getRequiredDouble(rawRun.sampling.topP, `runs[${runId}].sampling.topP`),
                topK: getRequiredInt(rawRun.sampling.topK, `runs[${runId}].sampling.topK`),
                minP: getRequiredDouble(rawRun.sampling.minP, `runs[${runId}].sampling.minP`),
                presencePenalty: getRequiredDouble(rawRun.sampling.presencePenalty, `runs[${runId}].sampling.presencePenalty`),
                repetitionPenalty: getRequiredDouble(rawRun.sampling.repetitionPenalty, `runs[${runId}].sampling.repetitionPenalty`),
            },
        };
        run.resolvedModelPath = resolveModelPathForStartScript(run.modelPath, run.startScript);
        if (!fs.existsSync(run.resolvedModelPath)) {
            throw new Error(`Run '${runId}' points at a missing model file: ${run.resolvedModelPath}`);
        }
        if (!fs.existsSync(run.startScript)) {
            throw new Error(`Run '${runId}' points at a missing start script: ${run.startScript}`);
        }
        if (run.promptPrefixFile && !fs.existsSync(run.promptPrefixFile)) {
            throw new Error(`Run '${runId}' points at a missing prompt prefix file: ${run.promptPrefixFile}`);
        }
        if (Boolean(rawRun.enabled)) {
            enabledRuns.push(run);
        }
    }
    if (enabledRuns.length < 1) {
        throw new Error('Manifest must have at least one enabled run.');
    }
    const selectedRuns = getSelectedRuns(enabledRuns, options.runIds);
    if (selectedRuns.length === 0) {
        throw new Error('No runs were selected.');
    }
    ensureDirectory(resultsRoot);
    return {
        manifestPath: resolvedManifestPath,
        manifestDirectory,
        fixtureRoot,
        configUrl,
        promptPrefixFile: manifestPromptPrefixFile,
        requestTimeoutSeconds,
        startScript,
        stopScript,
        resultsRoot,
        baseline,
        enabledRuns,
        selectedRuns,
    };
}
function buildLaunchSignature(target) {
    return [
        target.startScript,
        target.resolvedModelPath,
        String(target.contextSize),
        String(target.maxTokens),
        target.passReasoningArg ? target.reasoning : 'script-controlled',
    ].join('|');
}
function buildLauncherArgs(manifest, target) {
    const args = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', target.startScript,
        '-ConfigUrl', manifest.configUrl,
        '-ModelPath', target.modelPath,
        '-ContextSize', String(target.contextSize),
        '-MaxTokens', String(target.maxTokens),
    ];
    if (target.passReasoningArg) {
        args.push('-Reasoning', target.reasoning);
    }
    return args;
}
function buildBenchmarkArgs(manifest, run, outputPath, promptPrefixFile) {
    const args = [
        path.join(repoRoot, 'dist', 'benchmark.js'),
        '--fixture-root',
        manifest.fixtureRoot,
        '--model',
        run.modelId,
        '--output',
        outputPath,
    ];
    if (promptPrefixFile) {
        args.push('--prompt-prefix-file', promptPrefixFile);
    }
    args.push('--request-timeout-seconds', String(manifest.requestTimeoutSeconds));
    if (run.sampling) {
        args.push('--temperature', String(run.sampling.temperature), '--top-p', String(run.sampling.topP), '--top-k', String(run.sampling.topK), '--min-p', String(run.sampling.minP), '--presence-penalty', String(run.sampling.presencePenalty), '--repetition-penalty', String(run.sampling.repetitionPenalty));
    }
    args.push('--max-tokens', String(run.maxTokens));
    return args;
}
async function invokeConfigGet(configUrl) {
    return requestJson({
        url: configUrl,
        method: 'GET',
        timeoutMs: 10_000,
    });
}
async function invokeConfigSet(configUrl, config) {
    return requestJson({
        url: configUrl,
        method: 'PUT',
        timeoutMs: 10_000,
        body: JSON.stringify(config),
    });
}
function getRuntimeLlamaCppConfigValue(config, key) {
    const runtime = typeof config.Runtime === 'object' && config.Runtime !== null
        ? config.Runtime
        : null;
    const runtimeLlamaCpp = runtime && typeof runtime.LlamaCpp === 'object' && runtime.LlamaCpp !== null
        ? runtime.LlamaCpp
        : null;
    if (runtimeLlamaCpp && Object.prototype.hasOwnProperty.call(runtimeLlamaCpp, key)) {
        return runtimeLlamaCpp[key];
    }
    const llamaCpp = typeof config.LlamaCpp === 'object' && config.LlamaCpp !== null
        ? config.LlamaCpp
        : null;
    return llamaCpp?.[key];
}
async function getLlamaModels(baseUrl) {
    const response = await requestJson({
        url: `${baseUrl.replace(/\/$/u, '')}/v1/models`,
        method: 'GET',
        timeoutMs: 10_000,
    });
    return Array.isArray(response.data)
        ? response.data
            .map((item) => String(item?.id ?? '').trim())
            .filter(Boolean)
        : [];
}
async function waitForLlamaReadiness(baseUrl, expectedModelId, timeoutSeconds = 180) {
    const deadline = Date.now() + (timeoutSeconds * 1000);
    let lastError = '';
    while (Date.now() < deadline) {
        try {
            const models = await getLlamaModels(baseUrl);
            if (models.includes(expectedModelId)) {
                return models;
            }
            lastError = `llama-server is reachable but expected model '${expectedModelId}' is not loaded. Available models: ${models.length > 0 ? models.join(', ') : '<none>'}`;
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Timed out waiting for llama-server at ${baseUrl} to load model '${expectedModelId}'. Last error: ${lastError}`);
}
function spawnAndWait(options) {
    return new Promise((resolve, reject) => {
        ensureDirectory(path.dirname(options.stdoutPath));
        ensureDirectory(path.dirname(options.stderrPath));
        const stdout = fs.openSync(options.stdoutPath, 'w');
        const stderr = fs.openSync(options.stderrPath, 'w');
        const child = (0, node_child_process_1.spawn)(options.filePath, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', stdout, stderr],
            windowsHide: true,
        });
        child.once('error', (error) => {
            fs.closeSync(stdout);
            fs.closeSync(stderr);
            reject(error);
        });
        child.once('exit', (code) => {
            fs.closeSync(stdout);
            fs.closeSync(stderr);
            resolve({
                exitCode: code ?? 0,
                pid: child.pid ?? 0,
            });
        });
    });
}
async function invokeStopScript(stopScriptPath) {
    const result = await spawnAndWait({
        filePath: powerShellExe,
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScriptPath, '-Force'],
        cwd: path.dirname(stopScriptPath),
        stdoutPath: path.join(repoRoot, 'eval', 'results', 'tmp_stop_stdout.log'),
        stderrPath: path.join(repoRoot, 'eval', 'results', 'tmp_stop_stderr.log'),
    });
    if (result.exitCode !== 0) {
        throw new Error(`Stop script failed with exit code ${result.exitCode}.`);
    }
}
async function forceStopLlamaServer(sessionDirectory) {
    const stdoutPath = path.join(sessionDirectory, 'tmp_force_stop_stdout.log');
    const stderrPath = path.join(sessionDirectory, 'tmp_force_stop_stderr.log');
    const result = await spawnAndWait({
        filePath: powerShellExe,
        args: [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            "$existing = Get-Process 'llama-server' -ErrorAction SilentlyContinue; if ($existing) { $existing | Stop-Process -Force }; exit 0",
        ],
        cwd: repoRoot,
        stdoutPath,
        stderrPath,
    });
    if (result.exitCode !== 0) {
        throw new Error(`Force-stopping llama-server failed with exit code ${result.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
}
async function startLlamaLauncher(manifest, target, sessionDirectory) {
    const stdoutPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stdout.log`);
    const stderrPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stderr.log`);
    const args = buildLauncherArgs(manifest, target);
    ensureDirectory(sessionDirectory);
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');
    const child = (0, node_child_process_1.spawn)(powerShellExe, args, {
        cwd: path.dirname(target.startScript),
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
        detached: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const exited = child.exitCode !== null || child.signalCode !== null;
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    if (exited) {
        const stderrText = readTrimmedFileText(stderrPath);
        const stdoutText = readTrimmedFileText(stdoutPath);
        const details = [stderrText, stdoutText].filter(Boolean).join(' ').trim();
        throw new Error(`Launcher process exited before llama-server became ready.${details ? ` ${details}` : ''}`);
    }
    return {
        hostProcessId: child.pid ?? 0,
        stdoutPath,
        stderrPath,
    };
}
async function restartLlamaForTarget(manifest, target, sessionDirectory) {
    process.stdout.write(`Restarting llama-server for [${target.id}] ${target.label}\n`);
    if (manifest.stopScript) {
        await invokeStopScript(manifest.stopScript);
    }
    else {
        await forceStopLlamaServer(sessionDirectory);
    }
    await startLlamaLauncher(manifest, target, sessionDirectory);
    const config = await invokeConfigGet(manifest.configUrl);
    const baseUrl = getRequiredString(getRuntimeLlamaCppConfigValue(config, 'BaseUrl'), 'config.Runtime.LlamaCpp.BaseUrl');
    await waitForLlamaReadiness(baseUrl, target.modelId);
}
async function invokeBenchmarkProcess(manifest, run, outputPath, sessionDirectory, promptPrefixFile) {
    const { stdoutPath, stderrPath, runtimeStatusPath } = getBenchmarkProcessPaths(sessionDirectory, run);
    const benchmarkScriptPath = path.join(repoRoot, 'dist', 'benchmark.js');
    if (!fs.existsSync(benchmarkScriptPath)) {
        throw new Error(`Benchmark entrypoint not found: ${benchmarkScriptPath}. Run 'npm run build' first.`);
    }
    const args = buildBenchmarkArgs(manifest, run, outputPath, promptPrefixFile);
    const env = {
        ...process.env,
        sift_kit_status: runtimeStatusPath,
    };
    const result = await spawnAndWait({
        filePath: nodeExe,
        args,
        cwd: repoRoot,
        stdoutPath,
        stderrPath,
        env,
    });
    if (result.exitCode !== 0) {
        const stderrText = readTrimmedFileText(stderrPath);
        const stdoutText = readTrimmedFileText(stdoutPath);
        const details = [stderrText, stdoutText].filter(Boolean).join(' ').trim();
        throw new Error(`Benchmark command failed for run '${run.id}' with exit code ${result.exitCode}.${details ? ` ${details}` : ''}`);
    }
    if (!fs.existsSync(outputPath)) {
        throw new Error(`Benchmark run '${run.id}' completed without producing the expected artifact at ${outputPath}`);
    }
    return {
        stdoutPath,
        stderrPath,
        exitCode: result.exitCode,
    };
}
function writeMatrixIndex(filePath, index) {
    writeJsonFile(filePath, index);
}
function getBenchmarkProcessPaths(sessionDirectory, run) {
    return {
        stdoutPath: path.join(sessionDirectory, `benchmark_${run.index}_${run.id}_stdout.log`),
        stderrPath: path.join(sessionDirectory, `benchmark_${run.index}_${run.id}_stderr.log`),
        runtimeStatusPath: path.join(sessionDirectory, `runtime_${run.index}_${run.id}`, 'status', 'inference.txt'),
    };
}
function createMatrixInterruptSignal(onInterrupt) {
    let rejectInterrupted = () => { };
    const interrupted = new Promise((_resolve, reject) => {
        rejectInterrupted = reject;
    });
    let active = true;
    const onSignal = (signal) => {
        if (!active) {
            return;
        }
        active = false;
        const error = new MatrixInterruptedError(signal);
        onInterrupt(error);
        rejectInterrupted(error);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    return {
        interrupted,
        dispose: () => {
            active = false;
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        },
    };
}
async function withMatrixInterrupt(operation, interrupted) {
    return Promise.race([operation, interrupted]);
}
async function runMatrixWithInterrupt(options, interruptSignalOverride) {
    const manifest = readMatrixManifest(options);
    const resolvedPromptPrefixFile = options.promptPrefixFile
        ? resolvePathFromBase(options.promptPrefixFile, repoRoot)
        : manifest.promptPrefixFile;
    if (resolvedPromptPrefixFile && !fs.existsSync(resolvedPromptPrefixFile)) {
        throw new Error(`Prompt prefix file does not exist: ${resolvedPromptPrefixFile}`);
    }
    if (options.validateOnly) {
        process.stdout.write('Manifest validation passed.\n');
        process.stdout.write(`Manifest : ${manifest.manifestPath}\n`);
        process.stdout.write(`Fixture  : ${manifest.fixtureRoot}\n`);
        process.stdout.write(`Results  : ${manifest.resultsRoot}\n`);
        if (resolvedPromptPrefixFile) {
            process.stdout.write(`Prefix   : ${resolvedPromptPrefixFile}\n`);
        }
        process.stdout.write(`Run ids  : ${manifest.selectedRuns.map((run) => run.id).join(', ')}\n`);
        return;
    }
    const sessionDirectory = path.join(manifest.resultsRoot, getUtcTimestamp());
    ensureDirectory(sessionDirectory);
    const snapshotPath = path.join(sessionDirectory, 'pre_run_config_snapshot.json');
    const resolvedManifestPath = path.join(sessionDirectory, 'resolved_manifest.json');
    const indexPath = path.join(sessionDirectory, 'matrix_index.json');
    const initialConfig = await invokeConfigGet(manifest.configUrl);
    writeJsonFile(snapshotPath, initialConfig);
    writeJsonFile(resolvedManifestPath, manifest);
    const matrixIndex = {
        manifestPath: manifest.manifestPath,
        resolvedManifestPath,
        fixtureRoot: manifest.fixtureRoot,
        resultsRoot: manifest.resultsRoot,
        sessionDirectory,
        configUrl: manifest.configUrl,
        promptPrefixFile: resolvedPromptPrefixFile,
        selectedRunIds: manifest.selectedRuns.map((run) => run.id),
        startedAtUtc: new Date().toISOString(),
        completedAtUtc: null,
        status: 'running',
        configSnapshotPath: snapshotPath,
        baselineRestore: {
            status: 'pending',
            error: null,
        },
        runs: [],
    };
    writeMatrixIndex(indexPath, matrixIndex);
    let currentLaunchSignature = null;
    let capturedError = null;
    let restoreError = null;
    let activeRunEntry = null;
    const interruptSignal = interruptSignalOverride ?? createMatrixInterruptSignal((error) => {
        if (activeRunEntry && activeRunEntry.status === 'running') {
            activeRunEntry.status = 'failed';
            activeRunEntry.error = error.message;
            activeRunEntry.completedAtUtc = new Date().toISOString();
        }
        matrixIndex.status = 'failed';
        writeMatrixIndex(indexPath, matrixIndex);
    });
    try {
        await withMatrixInterrupt(restartLlamaForTarget(manifest, manifest.baseline, sessionDirectory), interruptSignal.interrupted);
        currentLaunchSignature = buildLaunchSignature(manifest.baseline);
        for (const run of manifest.selectedRuns) {
            const outputPath = path.join(sessionDirectory, `${String(run.index).padStart(2, '0')}_${run.id}.json`);
            const benchmarkPaths = getBenchmarkProcessPaths(sessionDirectory, run);
            const runEntry = {
                index: run.index,
                id: run.id,
                label: run.label,
                modelId: run.modelId,
                modelPath: run.resolvedModelPath,
                startScript: run.startScript,
                promptPrefixFile: run.promptPrefixFile,
                reasoning: run.reasoning,
                sampling: run.sampling,
                outputPath,
                benchmarkStdoutPath: benchmarkPaths.stdoutPath,
                benchmarkStderrPath: benchmarkPaths.stderrPath,
                startedAtUtc: new Date().toISOString(),
                completedAtUtc: null,
                status: 'running',
                error: null,
            };
            activeRunEntry = runEntry;
            matrixIndex.runs.push(runEntry);
            writeMatrixIndex(indexPath, matrixIndex);
            process.stdout.write(`Running [${run.id}] ${run.label}\n`);
            try {
                const requiredLaunchSignature = buildLaunchSignature(run);
                if (currentLaunchSignature !== requiredLaunchSignature) {
                    await withMatrixInterrupt(restartLlamaForTarget(manifest, run, sessionDirectory), interruptSignal.interrupted);
                    currentLaunchSignature = requiredLaunchSignature;
                }
                const benchmarkResult = await withMatrixInterrupt(invokeBenchmarkProcess(manifest, run, outputPath, sessionDirectory, run.promptPrefixFile ?? resolvedPromptPrefixFile), interruptSignal.interrupted);
                runEntry.benchmarkStdoutPath = benchmarkResult.stdoutPath;
                runEntry.benchmarkStderrPath = benchmarkResult.stderrPath;
                runEntry.status = 'completed';
                runEntry.completedAtUtc = new Date().toISOString();
                writeMatrixIndex(indexPath, matrixIndex);
                activeRunEntry = null;
            }
            catch (error) {
                runEntry.status = 'failed';
                runEntry.error = error instanceof Error ? error.message : String(error);
                runEntry.completedAtUtc = new Date().toISOString();
                matrixIndex.status = 'failed';
                writeMatrixIndex(indexPath, matrixIndex);
                activeRunEntry = null;
                throw error;
            }
        }
        matrixIndex.status = 'completed';
    }
    catch (error) {
        capturedError = error;
        matrixIndex.status = 'failed';
    }
    finally {
        interruptSignal.dispose();
        try {
            await restartLlamaForTarget(manifest, manifest.baseline, sessionDirectory);
            matrixIndex.baselineRestore.status = 'completed';
        }
        catch (error) {
            restoreError = error;
            matrixIndex.baselineRestore.status = 'failed';
            matrixIndex.baselineRestore.error = error instanceof Error ? error.message : String(error);
        }
        matrixIndex.completedAtUtc = new Date().toISOString();
        writeMatrixIndex(indexPath, matrixIndex);
    }
    if (capturedError !== null && restoreError !== null) {
        const runError = capturedError instanceof Error ? capturedError.message : String(capturedError);
        const baselineError = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(`Benchmark matrix failed: ${runError} Baseline restore also failed: ${baselineError}`);
    }
    if (capturedError !== null) {
        throw capturedError;
    }
    if (restoreError !== null) {
        throw restoreError;
    }
    process.stdout.write(`Benchmark matrix completed successfully. Session directory: ${sessionDirectory}\n`);
}
async function runMatrix(options) {
    await runMatrixWithInterrupt(options);
}
async function main() {
    await runMatrix(parseArguments(process.argv.slice(2)));
}
if (require.main === module) {
    void main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
