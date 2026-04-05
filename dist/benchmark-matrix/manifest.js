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
exports.readTrimmedFileText = readTrimmedFileText;
exports.resolveModelPathForStartScript = resolveModelPathForStartScript;
exports.getSelectedRuns = getSelectedRuns;
exports.readMatrixManifest = readMatrixManifest;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const fs_js_1 = require("../lib/fs.js");
const paths_js_1 = require("../lib/paths.js");
const args_js_1 = require("./args.js");
const types_js_1 = require("./types.js");
function readTrimmedFileText(filePath) {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim();
}
function resolveModelPathForStartScript(modelPath, startScriptPath) {
    return path.isAbsolute(modelPath)
        ? path.resolve(modelPath)
        : path.resolve(path.dirname(startScriptPath), modelPath);
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
    const resolvedManifestPath = (0, paths_js_1.resolvePathFromBase)(options.manifestPath, types_js_1.repoRoot);
    if (!fs.existsSync(resolvedManifestPath)) {
        throw new Error(`Manifest file not found: ${resolvedManifestPath}`);
    }
    const raw = (0, fs_js_1.readJsonFile)(resolvedManifestPath);
    const manifestDirectory = path.dirname(resolvedManifestPath);
    const fixtureRoot = (0, paths_js_1.resolvePathFromBase)((0, args_js_1.getRequiredString)(raw.fixtureRoot, 'fixtureRoot'), manifestDirectory);
    const startScript = (0, paths_js_1.resolvePathFromBase)((0, args_js_1.getRequiredString)(raw.startScript, 'startScript'), manifestDirectory);
    const stopScript = (0, paths_js_1.resolveOptionalPathFromBase)(raw.stopScript ?? null, manifestDirectory);
    const resultsRoot = (0, paths_js_1.resolvePathFromBase)((0, args_js_1.getRequiredString)(raw.resultsRoot, 'resultsRoot'), manifestDirectory);
    const configUrl = (0, args_js_1.getRequiredString)(raw.configUrl, 'configUrl');
    const manifestPromptPrefixFile = (0, paths_js_1.resolveOptionalPathFromBase)(raw.promptPrefixFile ?? null, manifestDirectory);
    const requestTimeoutSeconds = options.requestTimeoutSeconds
        ?? (0, args_js_1.getOptionalPositiveInt)(raw.requestTimeoutSeconds ?? null, 'requestTimeoutSeconds')
        ?? 1800;
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
    const baselineModelId = (0, args_js_1.getRequiredString)(raw.baseline.modelId, 'baseline.modelId');
    const baselineModelPath = (0, args_js_1.getRequiredString)(raw.baseline.modelPath, 'baseline.modelPath');
    const baselineReasoning = (0, args_js_1.getRequiredString)(raw.baseline.reasoning, 'baseline.reasoning');
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
        contextSize: (0, args_js_1.getRequiredInt)(raw.baseline.contextSize, 'baseline.contextSize'),
        maxTokens: (0, args_js_1.getRequiredInt)(raw.baseline.maxTokens, 'baseline.maxTokens'),
        reasoning: baselineReasoning,
        passReasoningArg: (0, args_js_1.getOptionalBoolean)(raw.baseline.passReasoningArg, 'baseline.passReasoningArg') ?? true,
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
        const runId = (0, args_js_1.getRequiredString)(rawRun.id, 'runs[].id');
        const normalizedId = runId.toLowerCase();
        if (idSet.has(normalizedId)) {
            throw new Error(`Duplicate run id found in manifest: ${runId}`);
        }
        idSet.add(normalizedId);
        if (!rawRun.sampling) {
            throw new Error(`Run '${runId}' is missing its sampling block.`);
        }
        const run = {
            index: (0, args_js_1.getRequiredInt)(rawRun.index, `runs[${runId}].index`),
            id: runId,
            label: (0, args_js_1.getRequiredString)(rawRun.label, `runs[${runId}].label`),
            modelId: (0, args_js_1.getRequiredString)(rawRun.modelId, `runs[${runId}].modelId`),
            modelPath: (0, args_js_1.getRequiredString)(rawRun.modelPath, `runs[${runId}].modelPath`),
            startScript: (0, paths_js_1.resolveOptionalPathFromBase)(rawRun.startScript ?? null, manifestDirectory) ?? startScript,
            resolvedModelPath: '',
            promptPrefixFile: (0, paths_js_1.resolveOptionalPathFromBase)(rawRun.promptPrefixFile ?? null, manifestDirectory),
            reasoning: (rawRun.reasoning ?? baseline.reasoning),
            contextSize: (0, args_js_1.getOptionalInt)(rawRun.contextSize, `runs[${runId}].contextSize`) ?? baseline.contextSize,
            maxTokens: (0, args_js_1.getOptionalInt)(rawRun.maxTokens, `runs[${runId}].maxTokens`) ?? baseline.maxTokens,
            passReasoningArg: (0, args_js_1.getOptionalBoolean)(rawRun.passReasoningArg, `runs[${runId}].passReasoningArg`) ?? baseline.passReasoningArg,
            sampling: {
                temperature: (0, args_js_1.getRequiredDouble)(rawRun.sampling.temperature, `runs[${runId}].sampling.temperature`),
                topP: (0, args_js_1.getRequiredDouble)(rawRun.sampling.topP, `runs[${runId}].sampling.topP`),
                topK: (0, args_js_1.getRequiredInt)(rawRun.sampling.topK, `runs[${runId}].sampling.topK`),
                minP: (0, args_js_1.getRequiredDouble)(rawRun.sampling.minP, `runs[${runId}].sampling.minP`),
                presencePenalty: (0, args_js_1.getRequiredDouble)(rawRun.sampling.presencePenalty, `runs[${runId}].sampling.presencePenalty`),
                repetitionPenalty: (0, args_js_1.getRequiredDouble)(rawRun.sampling.repetitionPenalty, `runs[${runId}].sampling.repetitionPenalty`),
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
    (0, fs_js_1.ensureDirectory)(resultsRoot);
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
