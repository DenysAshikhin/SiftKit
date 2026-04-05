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
exports.buildLaunchSignature = buildLaunchSignature;
exports.buildLauncherArgs = buildLauncherArgs;
exports.buildBenchmarkArgs = buildBenchmarkArgs;
exports.invokeStopScript = invokeStopScript;
exports.forceStopLlamaServer = forceStopLlamaServer;
exports.startLlamaLauncher = startLlamaLauncher;
exports.restartLlamaForTarget = restartLlamaForTarget;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const fs_js_1 = require("../lib/fs.js");
const args_js_1 = require("./args.js");
const config_rpc_js_1 = require("./config-rpc.js");
const manifest_js_1 = require("./manifest.js");
const process_js_1 = require("./process.js");
const pruning_js_1 = require("./pruning.js");
const types_js_1 = require("./types.js");
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
        path.join(types_js_1.repoRoot, 'dist', 'benchmark.js'),
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
async function invokeStopScript(stopScriptPath) {
    const result = await (0, process_js_1.spawnAndWait)({
        filePath: types_js_1.powerShellExe,
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScriptPath, '-Force'],
        cwd: path.dirname(stopScriptPath),
        stdoutPath: path.join(types_js_1.repoRoot, 'eval', 'results', 'tmp_stop_stdout.log'),
        stderrPath: path.join(types_js_1.repoRoot, 'eval', 'results', 'tmp_stop_stderr.log'),
    });
    if (result.exitCode !== 0) {
        throw new Error(`Stop script failed with exit code ${result.exitCode}.`);
    }
}
async function forceStopLlamaServer(sessionDirectory) {
    const stdoutPath = path.join(sessionDirectory, 'tmp_force_stop_stdout.log');
    const stderrPath = path.join(sessionDirectory, 'tmp_force_stop_stderr.log');
    const result = await (0, process_js_1.spawnAndWait)({
        filePath: types_js_1.powerShellExe,
        args: [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            "$existing = Get-Process 'llama-server' -ErrorAction SilentlyContinue; if ($existing) { $existing | Stop-Process -Force }; exit 0",
        ],
        cwd: types_js_1.repoRoot,
        stdoutPath,
        stderrPath,
    });
    if (result.exitCode !== 0) {
        throw new Error(`Force-stopping llama-server failed with exit code ${result.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
}
async function startLlamaLauncher(manifest, target, sessionDirectory) {
    (0, pruning_js_1.pruneOldLauncherLogs)(manifest.resultsRoot);
    const stdoutPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stdout.log`);
    const stderrPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stderr.log`);
    const args = buildLauncherArgs(manifest, target);
    (0, fs_js_1.ensureDirectory)(sessionDirectory);
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');
    const child = (0, node_child_process_1.spawn)(types_js_1.powerShellExe, args, {
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
        const stderrText = (0, manifest_js_1.readTrimmedFileText)(stderrPath);
        const stdoutText = (0, manifest_js_1.readTrimmedFileText)(stdoutPath);
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
    const config = await (0, config_rpc_js_1.invokeConfigGet)(manifest.configUrl);
    const baseUrl = (0, args_js_1.getRequiredString)((0, config_rpc_js_1.getRuntimeLlamaCppConfigValue)(config, 'BaseUrl'), 'config.Runtime.LlamaCpp.BaseUrl');
    await (0, config_rpc_js_1.waitForLlamaReadiness)(baseUrl, target.modelId);
}
