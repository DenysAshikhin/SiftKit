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
exports.runMatrixWithInterrupt = runMatrixWithInterrupt;
exports.runMatrix = runMatrix;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const fs_js_1 = require("../lib/fs.js");
const paths_js_1 = require("../lib/paths.js");
const time_js_1 = require("../lib/time.js");
const args_js_1 = require("./args.js");
const benchmark_runner_js_1 = require("./benchmark-runner.js");
const config_rpc_js_1 = require("./config-rpc.js");
const interrupt_js_1 = require("./interrupt.js");
const launcher_js_1 = require("./launcher.js");
const manifest_js_1 = require("./manifest.js");
const types_js_1 = require("./types.js");
function writeMatrixIndex(filePath, index) {
    (0, fs_js_1.writeJsonFile)(filePath, index);
}
async function runMatrixWithInterrupt(options, interruptSignalOverride) {
    const manifest = (0, manifest_js_1.readMatrixManifest)(options);
    const resolvedPromptPrefixFile = options.promptPrefixFile
        ? (0, paths_js_1.resolvePathFromBase)(options.promptPrefixFile, types_js_1.repoRoot)
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
    const sessionDirectory = path.join(manifest.resultsRoot, (0, time_js_1.getUtcTimestamp)());
    (0, fs_js_1.ensureDirectory)(sessionDirectory);
    const snapshotPath = path.join(sessionDirectory, 'pre_run_config_snapshot.json');
    const resolvedManifestPath = path.join(sessionDirectory, 'resolved_manifest.json');
    const indexPath = path.join(sessionDirectory, 'matrix_index.json');
    const initialConfig = await (0, config_rpc_js_1.invokeConfigGet)(manifest.configUrl);
    (0, fs_js_1.writeJsonFile)(snapshotPath, initialConfig);
    (0, fs_js_1.writeJsonFile)(resolvedManifestPath, manifest);
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
    const interruptSignal = interruptSignalOverride ?? (0, interrupt_js_1.createMatrixInterruptSignal)((error) => {
        if (activeRunEntry && activeRunEntry.status === 'running') {
            activeRunEntry.status = 'failed';
            activeRunEntry.error = error.message;
            activeRunEntry.completedAtUtc = new Date().toISOString();
        }
        matrixIndex.status = 'failed';
        writeMatrixIndex(indexPath, matrixIndex);
    });
    try {
        await (0, interrupt_js_1.withMatrixInterrupt)((0, launcher_js_1.restartLlamaForTarget)(manifest, manifest.baseline, sessionDirectory), interruptSignal.interrupted);
        currentLaunchSignature = (0, launcher_js_1.buildLaunchSignature)(manifest.baseline);
        for (const run of manifest.selectedRuns) {
            const outputPath = path.join(sessionDirectory, `${String(run.index).padStart(2, '0')}_${run.id}.json`);
            const benchmarkPaths = (0, benchmark_runner_js_1.getBenchmarkProcessPaths)(sessionDirectory, run);
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
                const requiredLaunchSignature = (0, launcher_js_1.buildLaunchSignature)(run);
                if (currentLaunchSignature !== requiredLaunchSignature) {
                    await (0, interrupt_js_1.withMatrixInterrupt)((0, launcher_js_1.restartLlamaForTarget)(manifest, run, sessionDirectory), interruptSignal.interrupted);
                    currentLaunchSignature = requiredLaunchSignature;
                }
                const benchmarkResult = await (0, interrupt_js_1.withMatrixInterrupt)((0, benchmark_runner_js_1.invokeBenchmarkProcess)(manifest, run, outputPath, sessionDirectory, run.promptPrefixFile ?? resolvedPromptPrefixFile), interruptSignal.interrupted);
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
            await (0, launcher_js_1.restartLlamaForTarget)(manifest, manifest.baseline, sessionDirectory);
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
    await runMatrix((0, args_js_1.parseArguments)(process.argv.slice(2)));
}
