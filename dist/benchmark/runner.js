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
exports.runBenchmarkSuite = runBenchmarkSuite;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const index_js_1 = require("../config/index.js");
const fs_js_1 = require("../lib/fs.js");
const summary_js_1 = require("../summary.js");
const time_js_1 = require("../lib/time.js");
const args_js_1 = require("./args.js");
const fixtures_js_1 = require("./fixtures.js");
const interrupt_js_1 = require("./interrupt.js");
const report_js_1 = require("./report.js");
const types_js_1 = require("./types.js");
async function runBenchmarkSuite(options = {}) {
    const fixtureRoot = path.resolve(options.fixtureRoot || path.join((0, args_js_1.getRepoRoot)(), 'eval', 'fixtures'));
    const outputPath = path.resolve(options.outputPath || (0, args_js_1.getDefaultOutputPath)(fixtureRoot));
    const manifest = (0, fixtures_js_1.getFixtureManifest)(fixtureRoot);
    const config = await (0, index_js_1.loadConfig)({ ensure: true });
    const backend = options.backend || config.Backend;
    const model = options.model || (0, index_js_1.getConfiguredModel)(config);
    const promptPrefix = (0, args_js_1.resolvePromptPrefix)(options);
    const requestTimeoutSeconds = (0, args_js_1.getValidatedRequestTimeoutSeconds)(options);
    const startedAt = new Date();
    const startedAtHr = process.hrtime.bigint();
    const results = [];
    const interruptSignal = (0, interrupt_js_1.createInterruptSignal)();
    let fatalError = null;
    let fatalException = null;
    try {
        for (let index = 0; index < manifest.length; index += 1) {
            const fixture = manifest[index];
            const fixtureLabel = fixture.Name || fixture.File;
            const sourcePath = path.join(fixtureRoot, fixture.File);
            const inputText = fs.readFileSync(sourcePath, 'utf8');
            const prompt = (0, args_js_1.getPromptLabel)({ fixture });
            const caseStartedAtHr = process.hrtime.bigint();
            const caseStartedAtMs = Date.now();
            const heartbeat = (0, interrupt_js_1.createFixtureHeartbeat)({
                fixtureLabel,
                fixtureIndex: index + 1,
                fixtureCount: manifest.length,
                startedAtMs: caseStartedAtMs,
            });
            process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] start\n`);
            try {
                const response = await (0, interrupt_js_1.runWithFixtureDeadline)((0, summary_js_1.summarizeRequest)({
                    question: fixture.Question,
                    inputText,
                    format: fixture.Format,
                    policyProfile: fixture.PolicyProfile,
                    backend,
                    model,
                    promptPrefix,
                    requestTimeoutSeconds,
                    llamaCppOverrides: options.llamaCppOverrides,
                    sourceKind: 'standalone',
                }), {
                    fixtureLabel,
                    requestTimeoutSeconds,
                    interrupted: interruptSignal.interrupted,
                });
                const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;
                clearInterval(heartbeat);
                results.push({
                    Prompt: prompt,
                    Output: response.Summary,
                    DurationMs: (0, report_js_1.roundDuration)(caseDurationMs),
                    PolicyDecision: response.PolicyDecision,
                    Classification: response.Classification,
                    RawReviewRequired: response.RawReviewRequired,
                    ModelCallSucceeded: response.ModelCallSucceeded,
                    Error: response.ProviderError,
                });
                process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] completed in ${(0, time_js_1.formatElapsed)(caseDurationMs)}\n`);
            }
            catch (error) {
                const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;
                clearInterval(heartbeat);
                const message = error instanceof Error ? error.message : String(error);
                fatalError = error instanceof types_js_1.FatalBenchmarkError || (0, interrupt_js_1.isTimeoutError)(error)
                    ? message
                    : `Benchmark fixture '${fixtureLabel}' failed: ${message}`;
                fatalException = error;
                process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] failed fatally after ${(0, time_js_1.formatElapsed)(caseDurationMs)}: ${message}\n`);
                break;
            }
        }
    }
    finally {
        interruptSignal.dispose();
    }
    const artifact = (0, report_js_1.buildBenchmarkArtifact)({
        status: fatalError === null ? 'completed' : 'failed',
        startedAt,
        backend,
        model,
        fixtureRoot,
        outputPath,
        promptPrefix,
        results,
        startedAtHr,
        fatalError,
    });
    (0, fs_js_1.saveContentAtomically)(outputPath, JSON.stringify(artifact, null, 2));
    if (fatalException !== null) {
        throw new types_js_1.FatalBenchmarkError(fatalError ?? (fatalException instanceof Error ? fatalException.message : String(fatalException)));
    }
    return artifact;
}
async function main() {
    const result = await runBenchmarkSuite((0, args_js_1.parseArguments)(process.argv.slice(2)));
    process.stdout.write(`${result.OutputPath}\n`);
}
