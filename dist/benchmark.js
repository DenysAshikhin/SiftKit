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
function shouldSummarize(options) {
    const decision = (0, summary_js_1.getSummaryDecision)(options.inputText, options.fixture.Question, options.fixture.PolicyProfile === 'risky-operation' ? 'risky' : 'informational', options.config);
    return decision.ShouldSummarize;
}
function getPromptLabel(options) {
    if (options.fixture.SourceCommand?.trim()) {
        return options.fixture.SourceCommand.trim();
    }
    if (shouldSummarize(options)) {
        return (0, summary_js_1.buildPrompt)({
            question: options.fixture.Question,
            inputText: '<benchmark fixture input>',
            format: options.fixture.Format,
            policyProfile: options.fixture.PolicyProfile,
            rawReviewRequired: (0, summary_js_1.getSummaryDecision)(options.inputText, options.fixture.Question, options.fixture.PolicyProfile === 'risky-operation' ? 'risky' : 'informational', options.config).RawReviewRequired,
        });
    }
    return options.fixture.Question;
}
async function runBenchmarkSuite(options = {}) {
    const fixtureRoot = path.resolve(options.fixtureRoot || path.join(getRepoRoot(), 'eval', 'fixtures'));
    const outputPath = path.resolve(options.outputPath || getDefaultOutputPath(fixtureRoot));
    const manifest = getFixtureManifest(fixtureRoot);
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    const backend = options.backend || config.Backend;
    const model = options.model || config.Model;
    const startedAt = new Date();
    const startedAtHr = process.hrtime.bigint();
    const results = [];
    for (const fixture of manifest) {
        const sourcePath = path.join(fixtureRoot, fixture.File);
        const inputText = fs.readFileSync(sourcePath, 'utf8');
        const prompt = getPromptLabel({
            config,
            fixture,
            inputText,
        });
        const caseStartedAtHr = process.hrtime.bigint();
        const response = await (0, summary_js_1.summarizeRequest)({
            question: fixture.Question,
            inputText,
            format: fixture.Format,
            policyProfile: fixture.PolicyProfile,
            backend,
            model,
        });
        const caseDurationMs = Number(process.hrtime.bigint() - caseStartedAtHr) / 1_000_000;
        results.push({
            Prompt: prompt,
            Output: response.Summary,
            DurationMs: Math.round(caseDurationMs * 1000) / 1000,
        });
    }
    const completedAt = new Date();
    const totalDurationMs = Number(process.hrtime.bigint() - startedAtHr) / 1_000_000;
    const artifact = {
        TotalDurationMs: Math.round(totalDurationMs * 1000) / 1000,
        StartedAtUtc: startedAt.toISOString(),
        CompletedAtUtc: completedAt.toISOString(),
        Backend: backend,
        Model: model,
        FixtureRoot: fixtureRoot,
        OutputPath: outputPath,
        Results: results,
    };
    (0, config_js_1.saveContentAtomically)(outputPath, JSON.stringify(artifact, null, 2));
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
