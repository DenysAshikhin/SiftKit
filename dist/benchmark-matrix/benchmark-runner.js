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
exports.getBenchmarkProcessPaths = getBenchmarkProcessPaths;
exports.invokeBenchmarkProcess = invokeBenchmarkProcess;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const launcher_js_1 = require("./launcher.js");
const manifest_js_1 = require("./manifest.js");
const process_js_1 = require("./process.js");
const types_js_1 = require("./types.js");
function getBenchmarkProcessPaths(sessionDirectory, run) {
    return {
        stdoutPath: path.join(sessionDirectory, `benchmark_${run.index}_${run.id}_stdout.log`),
        stderrPath: path.join(sessionDirectory, `benchmark_${run.index}_${run.id}_stderr.log`),
        runtimeStatusPath: path.join(sessionDirectory, `runtime_${run.index}_${run.id}`, 'status', 'inference.txt'),
    };
}
async function invokeBenchmarkProcess(manifest, run, outputPath, sessionDirectory, promptPrefixFile) {
    const { stdoutPath, stderrPath, runtimeStatusPath } = getBenchmarkProcessPaths(sessionDirectory, run);
    const benchmarkScriptPath = path.join(types_js_1.repoRoot, 'dist', 'benchmark.js');
    if (!fs.existsSync(benchmarkScriptPath)) {
        throw new Error(`Benchmark entrypoint not found: ${benchmarkScriptPath}. Run 'npm run build' first.`);
    }
    const args = (0, launcher_js_1.buildBenchmarkArgs)(manifest, run, outputPath, promptPrefixFile);
    const env = {
        ...process.env,
        sift_kit_status: runtimeStatusPath,
    };
    const result = await (0, process_js_1.spawnAndWait)({
        filePath: types_js_1.nodeExe,
        args,
        cwd: types_js_1.repoRoot,
        stdoutPath,
        stderrPath,
        env,
    });
    if (result.exitCode !== 0) {
        const stderrText = (0, manifest_js_1.readTrimmedFileText)(stderrPath);
        const stdoutText = (0, manifest_js_1.readTrimmedFileText)(stdoutPath);
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
