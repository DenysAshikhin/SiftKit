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
exports.parseArgs = parseArgs;
exports.resolveWorkItem = resolveWorkItem;
exports.runDebugRequest = runDebugRequest;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// Load the compiled artifact at runtime. Works from both the source location
// (scripts/) and the compiled location (dist/scripts/).
function requireCompiledSummary() {
    const candidates = [
        path.resolve(__dirname, '..', 'dist', 'summary.js'),
        path.resolve(__dirname, '..', '..', 'dist', 'summary.js'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require(candidate);
        }
    }
    throw new Error(`Unable to locate dist/summary.js. Run npm run build first.`);
}
const { summarizeRequest } = requireCompiledSummary();
function parseArgs(argv) {
    const parsed = {
        fixtureIndex: 48,
        fixtureRoot: path.join(process.cwd(), 'eval', 'fixtures', 'ai_core_60_tests'),
        requestTimeoutSeconds: 600,
        file: '',
        question: '',
        format: 'text',
        policyProfile: 'general',
        outputRoot: '',
        traceSummary: true,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        switch (token) {
            case '--fixture-index':
                parsed.fixtureIndex = Number(argv[++index]);
                break;
            case '--fixture-root':
                parsed.fixtureRoot = path.resolve(argv[++index]);
                break;
            case '--request-timeout-seconds':
                parsed.requestTimeoutSeconds = Number(argv[++index]);
                break;
            case '--file':
                parsed.file = path.resolve(argv[++index]);
                break;
            case '--question':
                parsed.question = argv[++index];
                break;
            case '--format':
                parsed.format = argv[++index];
                break;
            case '--policy-profile':
                parsed.policyProfile = argv[++index];
                break;
            case '--output-root':
                parsed.outputRoot = path.resolve(argv[++index]);
                break;
            case '--trace-summary':
                parsed.traceSummary = argv[++index] !== '0';
                break;
            default:
                throw new Error(`Unknown argument: ${token}`);
        }
    }
    if (!Number.isFinite(parsed.requestTimeoutSeconds) || parsed.requestTimeoutSeconds <= 0) {
        throw new Error('request-timeout-seconds must be a positive number.');
    }
    if (parsed.file) {
        if (!parsed.question.trim()) {
            throw new Error('Direct file mode requires --question.');
        }
    }
    else if (!Number.isInteger(parsed.fixtureIndex) || parsed.fixtureIndex <= 0) {
        throw new Error('fixture-index must be a positive integer.');
    }
    return parsed;
}
function getTimestamp() {
    const current = new Date();
    const yyyy = current.getFullYear();
    const MM = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const hh = String(current.getHours()).padStart(2, '0');
    const mm = String(current.getMinutes()).padStart(2, '0');
    const ss = String(current.getSeconds()).padStart(2, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}
function formatDurationMs(durationMs) {
    if (durationMs < 1000) {
        return `${durationMs.toFixed(1)}ms`;
    }
    return `${(durationMs / 1000).toFixed(3)}s`;
}
function createLogger(logPath, stdoutTarget = process.stdout, stderrTarget = process.stderr) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '', 'utf8');
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk, encoding, callback) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        fs.appendFileSync(logPath, text, 'utf8');
        if (stderrTarget && stderrTarget !== process.stderr && typeof stderrTarget.write === 'function') {
            stderrTarget.write(text);
            return true;
        }
        return originalStderrWrite(chunk, encoding, callback);
    });
    return {
        log(message) {
            const line = `[fixture-debug ${new Date().toISOString()}] ${message}`;
            stdoutTarget.write(`${line}\n`);
            fs.appendFileSync(logPath, `${line}\n`, 'utf8');
        },
        restore() {
            process.stderr.write = originalStderrWrite;
        },
    };
}
function resolveWorkItem(args) {
    if (args.file) {
        return {
            label: path.basename(args.file),
            sourcePath: args.file,
            question: args.question,
            format: args.format,
            policyProfile: args.policyProfile,
            inputText: fs.readFileSync(args.file, 'utf8'),
        };
    }
    const manifestPath = path.join(args.fixtureRoot, 'fixtures.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const fixture = manifest[args.fixtureIndex - 1];
    if (!fixture) {
        throw new Error(`Fixture ${args.fixtureIndex} not found in ${manifestPath}.`);
    }
    const sourcePath = path.join(args.fixtureRoot, fixture.File);
    return {
        label: fixture.Name,
        sourcePath,
        question: fixture.Question,
        format: fixture.Format,
        policyProfile: fixture.PolicyProfile,
        inputText: fs.readFileSync(sourcePath, 'utf8'),
    };
}
async function runDebugRequest(argv, options = {}) {
    const args = parseArgs(argv);
    const repoRoot = path.resolve(__dirname, '..');
    const outputRoot = args.outputRoot || path.join(repoRoot, 'tmp-find', `fixture_debug_${getTimestamp()}`);
    const logPath = path.join(outputRoot, 'debug.log');
    const artifactPath = path.join(outputRoot, 'result.json');
    const summaryPath = path.join(outputRoot, 'summary.txt');
    const stdoutTarget = options.stdout || process.stdout;
    const stderrTarget = options.stderr || process.stderr;
    const logger = createLogger(logPath, stdoutTarget, stderrTarget);
    const workItem = resolveWorkItem(args);
    if (args.traceSummary) {
        process.env.SIFTKIT_TRACE_SUMMARY = '1';
    }
    logger.log(`Output root: ${outputRoot}`);
    logger.log(`Log path: ${logPath}`);
    logger.log(`Source path: ${workItem.sourcePath}`);
    logger.log(`Input chars: ${workItem.inputText.length}`);
    logger.log(`Question: ${workItem.question}`);
    logger.log(`Format: ${workItem.format}`);
    logger.log(`Policy profile: ${workItem.policyProfile}`);
    logger.log(`Request timeout seconds: ${args.requestTimeoutSeconds}`);
    logger.log('Calling summarizeRequest...');
    const startedAt = process.hrtime.bigint();
    try {
        const result = await summarizeRequest({
            question: workItem.question,
            inputText: workItem.inputText,
            format: workItem.format,
            policyProfile: workItem.policyProfile,
            requestTimeoutSeconds: args.requestTimeoutSeconds,
        });
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const artifact = {
            ok: true,
            requestId: result.RequestId,
            durationMs,
            label: workItem.label,
            sourcePath: workItem.sourcePath,
            classification: result.Classification,
            rawReviewRequired: result.RawReviewRequired,
            modelCallSucceeded: result.ModelCallSucceeded,
            summary: result.Summary,
            summaryPreview: result.Summary.slice(0, 1000),
            providerError: result.ProviderError,
        };
        fs.mkdirSync(outputRoot, { recursive: true });
        fs.writeFileSync(summaryPath, result.Summary, 'utf8');
        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        logger.log(`summarizeRequest completed in ${formatDurationMs(durationMs)}`);
        logger.log(`Request id: ${result.RequestId}`);
        logger.log(`Result classification: ${result.Classification}`);
        logger.log(`Summary path: ${summaryPath}`);
        logger.log(`Artifact path: ${artifactPath}`);
        stdoutTarget.write(result.Summary.endsWith('\n') ? result.Summary : `${result.Summary}\n`);
        return {
            exitCode: 0,
            artifactPath,
            artifact,
        };
    }
    catch (error) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const message = error instanceof Error ? (error.stack || error.message) : String(error);
        const artifact = {
            ok: false,
            durationMs,
            label: workItem.label,
            sourcePath: workItem.sourcePath,
            error: message,
        };
        fs.mkdirSync(outputRoot, { recursive: true });
        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        logger.log(`summarizeRequest failed in ${formatDurationMs(durationMs)}`);
        logger.log(`Artifact path: ${artifactPath}`);
        stderrTarget.write(`${message}\n`);
        return {
            exitCode: 1,
            artifactPath,
            artifact,
        };
    }
    finally {
        logger.restore();
    }
}
async function main() {
    const result = await runDebugRequest(process.argv.slice(2));
    process.exit(result.exitCode);
}
if (require.main === module) {
    main().catch((error) => {
        const message = error instanceof Error ? (error.stack || error.message) : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
