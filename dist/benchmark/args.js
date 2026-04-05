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
exports.getRepoRoot = getRepoRoot;
exports.parseArguments = parseArguments;
exports.resolvePromptPrefix = resolvePromptPrefix;
exports.getValidatedRequestTimeoutSeconds = getValidatedRequestTimeoutSeconds;
exports.getDefaultOutputPath = getDefaultOutputPath;
exports.getPromptLabel = getPromptLabel;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const config_js_1 = require("../config.js");
const summary_js_1 = require("../summary.js");
const time_js_1 = require("../lib/time.js");
const types_js_1 = require("./types.js");
function getRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
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
    const timeoutSeconds = options.requestTimeoutSeconds ?? types_js_1.DEFAULT_REQUEST_TIMEOUT_SECONDS;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error('Request timeout seconds must be a positive number.');
    }
    return timeoutSeconds;
}
function getDefaultOutputPath(fixtureRoot) {
    if (fixtureRoot && fixtureRoot.trim()) {
        return path.join(path.resolve(fixtureRoot), `benchmark_run_${(0, time_js_1.getLocalTimestamp)()}.json`);
    }
    const paths = (0, config_js_1.initializeRuntime)();
    return path.join(paths.EvalResults, `benchmark_run_${(0, time_js_1.getLocalTimestamp)()}.json`);
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
