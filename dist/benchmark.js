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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const config_js_1 = require("./config.js");
const summary_js_1 = require("./summary.js");
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 600;
const BENCHMARK_HEARTBEAT_MS = 15_000;
class FatalBenchmarkError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FatalBenchmarkError';
    }
}
function getRepoRoot() {
    return path.resolve(__dirname, '..', '..');
}
function parseArguments(argv) {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        switch (token) {
            case '--fixture-root':
                parsed.fixtureRoot = argv[++index];
                break;
            case '--output':
                parsed.outputPath = argv[++index];
                break;
            case '--backend':
                parsed.backend = argv[++index];
                break;
            case '--model':
                parsed.model = argv[++index];
                break;
            case '--prompt-prefix':
                parsed.promptPrefix = argv[++index];
                break;
            case '--prompt-prefix-file':
                parsed.promptPrefixFile = argv[++index];
                break;
            case '--request-timeout-seconds':
                parsed.requestTimeoutSeconds = Number(argv[++index]);
                break;
            case '--temperature':
                parsed.llamaCppOverrides ??= {};
                parsed.llamaCppOverrides.Temperature = Number(argv[++index]);
                break;
            case '--top-p':
                parsed.llamaCppOverrides ??= {};
                parsed.llamaCppOverrides.TopP = Number(argv[++index]);
                break;
            case '--top-k':
                parsed.llamaCppOverrides ??= {};
                parsed.llamaCppOverrides.TopK = Number(argv[++index]);
                break;
            case '--min-p':
                parsed.llamaCppOverrides ??= {};
                parsed.llamaCppOverrides.MinP = Number(argv[++index]);
                break;
            case '--presence-penalty':
                parsed.llamaCppOverrides ??= {};
                parsed.llamaCppOverrides.PresencePenalty = Number(argv[++index]);
                break;
            case '--repetition-penalty':
                parsed.llamaCppOverrides ??= {};
                parsed.llamaCppOverrides.RepetitionPenalty = Number(argv[++index]);
                break;
            case '--max-tokens':
                parsed.llamaCppOverrides ??= {};
                parsed.llamaCppOverrides.MaxTokens = Number(argv[++index]);
                break;
            default:
                throw new Error(`Unknown argument: ${token}`);
        }
    }
    return parsed;
}
function getFixtureManifest(fixtureRoot) {
    const manifestPath = path.join(fixtureRoot, 'fixtures.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}
function resolvePromptPrefix(options) {
    if (options.promptPrefix && options.promptPrefixFile) {
        throw new Error('Pass only one of --prompt-prefix or --prompt-prefix-file.');
    }
    if (options.promptPrefixFile?.trim()) {
        return fs.readFileSync(path.resolve(options.promptPrefixFile.trim()), 'utf8');
    }
    if (options.promptPrefix?.trim()) {
        return options.promptPrefix;
    }
    return undefined;
}
function getValidatedRequestTimeoutSeconds(options) {
    const timeoutSeconds = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error('Request timeout seconds must be a positive number.');
    }
    return timeoutSeconds;
}
function getTimestamp() {
    const current = new Date();
    const yyyy = current.getFullYear();
    const MM = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const hh = String(current.getHours()).padStart(2, '0');
    const mm = String(current.getMinutes()).padStart(2, '0');
    const ss = String(current.getSeconds()).padStart(2, '0');
    const fff = String(current.getMilliseconds()).padStart(3, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}
function getDefaultOutputPath(fixtureRoot) {
    if (fixtureRoot && fixtureRoot.trim()) {
        return path.join(path.resolve(fixtureRoot), `benchmark_run_${getTimestamp()}.json`);
    }
    const paths = (0, config_js_1.initializeRuntime)();
    return path.join(paths.EvalResults, `benchmark_run_${getTimestamp()}.json`);
}
function getPromptLabel(options) {
    if (options.fixture.SourceCommand?.trim()) {
        return options.fixture.SourceCommand.trim();
    }
    return (0, summary_js_1.buildPrompt)({
        question: options.fixture.Question,
        inputText: '<benchmark fixture input>',
        format: options.fixture.Format,
        policyProfile: options.fixture.PolicyProfile,
        rawReviewRequired: false,
        sourceKind: 'standalone',
    });
}
function roundDuration(durationMs) {
    return Math.round(durationMs * 1000) / 1000;
}
function formatElapsed(durationMs) {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0
        ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
        : `${seconds}s`;
}
function buildBenchmarkArtifact(options) {
    const completedAt = new Date();
    const totalDurationMs = Number(process.hrtime.bigint() - options.startedAtHr) / 1_000_000;
    return {
        Status: options.status,
        TotalDurationMs: roundDuration(totalDurationMs),
        StartedAtUtc: options.startedAt.toISOString(),
        CompletedAtUtc: completedAt.toISOString(),
        Backend: options.backend,
        Model: options.model,
        FixtureRoot: options.fixtureRoot,
        OutputPath: options.outputPath,
        PromptPrefix: options.promptPrefix ?? null,
        CompletedFixtureCount: options.results.length,
        FatalError: options.fatalError,
        Results: options.results,
    };
}
function createInterruptSignal() {
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
        rejectInterrupted(new FatalBenchmarkError(`Benchmark interrupted by ${signal}.`));
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
function createFixtureHeartbeat(options) {
    const handle = setInterval(() => {
        const elapsedMs = Date.now() - options.startedAtMs;
        process.stdout.write(`Fixture ${options.fixtureIndex}/${options.fixtureCount} [${options.fixtureLabel}] still running after ${formatElapsed(elapsedMs)}\n`);
    }, BENCHMARK_HEARTBEAT_MS);
    if (typeof handle.unref === 'function') {
        handle.unref();
    }
    return handle;
}
async function runWithFixtureDeadline(operation, options) {
    return new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
            reject(new FatalBenchmarkError(`Benchmark fixture '${options.fixtureLabel}' timed out after ${options.requestTimeoutSeconds} seconds.`));
        }, options.requestTimeoutSeconds * 1000);
        if (typeof timeoutHandle.unref === 'function') {
            timeoutHandle.unref();
        }
        const resolveOnce = (value) => {
            clearTimeout(timeoutHandle);
            resolve(value);
        };
        const rejectOnce = (error) => {
            clearTimeout(timeoutHandle);
            reject(error);
        };
        operation.then((value) => resolveOnce(value), (error) => rejectOnce(error));
        options.interrupted.then(() => undefined, (error) => rejectOnce(error));
    });
}
function isTimeoutError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /\btimed out after\b/iu.test(message);
}
async function runBenchmarkSuite(options = {}) {
    const fixtureRoot = path.resolve(options.fixtureRoot || path.join(getRepoRoot(), 'eval', 'fixtures'));
    const outputPath = path.resolve(options.outputPath || getDefaultOutputPath(fixtureRoot));
    const manifest = getFixtureManifest(fixtureRoot);
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    const backend = options.backend || config.Backend;
    const model = options.model || (0, config_js_1.getConfiguredModel)(config);
    const promptPrefix = resolvePromptPrefix(options);
    const requestTimeoutSeconds = getValidatedRequestTimeoutSeconds(options);
    const startedAt = new Date();
    const startedAtHr = process.hrtime.bigint();
    const results = [];
    const interruptSignal = createInterruptSignal();
    let fatalError = null;
    let fatalException = null;
    try {
        for (let index = 0; index < manifest.length; index += 1) {
            const fixture = manifest[index];
            const fixtureLabel = fixture.Name || fixture.File;
            const sourcePath = path.join(fixtureRoot, fixture.File);
            const inputText = fs.readFileSync(sourcePath, 'utf8');
            const prompt = getPromptLabel({ fixture });
            const caseStartedAtHr = process.hrtime.bigint();
            const caseStartedAtMs = Date.now();
            const heartbeat = createFixtureHeartbeat({
                fixtureLabel,
                fixtureIndex: index + 1,
                fixtureCount: manifest.length,
                startedAtMs: caseStartedAtMs,
            });
            process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] start\n`);
            try {
                const response = await runWithFixtureDeadline((0, summary_js_1.summarizeRequest)({
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
                    DurationMs: roundDuration(caseDurationMs),
                    PolicyDecision: response.PolicyDecision,
                    Classification: response.Classification,
                    RawReviewRequired: response.RawReviewRequired,
                    ModelCallSucceeded: response.ModelCallSucceeded,
                    Error: response.ProviderError,
                });
                process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] completed in ${formatElapsed(caseDurationMs)}\n`);
            }
            catch (error) {
                const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;
                clearInterval(heartbeat);
                const message = error instanceof Error ? error.message : String(error);
                if (error instanceof FatalBenchmarkError || isTimeoutError(error)) {
                    fatalError = message;
                    fatalException = error;
                    process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] failed fatally after ${formatElapsed(caseDurationMs)}\n`);
                    break;
                }
                results.push({
                    Prompt: prompt,
                    Output: null,
                    DurationMs: roundDuration(caseDurationMs),
                    PolicyDecision: 'provider-error',
                    Classification: null,
                    RawReviewRequired: false,
                    ModelCallSucceeded: false,
                    Error: message,
                });
                process.stdout.write(`Fixture ${index + 1}/${manifest.length} [${fixtureLabel}] recorded provider error in ${formatElapsed(caseDurationMs)}\n`);
            }
        }
    }
    finally {
        interruptSignal.dispose();
    }
    const artifact = buildBenchmarkArtifact({
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
    (0, config_js_1.saveContentAtomically)(outputPath, JSON.stringify(artifact, null, 2));
    if (fatalException !== null) {
        throw fatalException;
    }
    return artifact;
}
async function main() {
    const result = await runBenchmarkSuite(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${result.OutputPath}\n`);
}
if (require.main === module) {
    void main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
