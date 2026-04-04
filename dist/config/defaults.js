"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultConfigObject = getDefaultConfigObject;
const constants_js_1 = require("./constants.js");
const paths_js_1 = require("./paths.js");
function getDefaultConfigObject() {
    const runtimePaths = (0, paths_js_1.initializeRuntime)();
    return {
        Version: constants_js_1.SIFTKIT_VERSION,
        Backend: 'llama.cpp',
        PolicyMode: 'conservative',
        RawLogRetention: true,
        PromptPrefix: constants_js_1.SIFT_DEFAULT_PROMPT_PREFIX,
        LlamaCpp: {
            BaseUrl: constants_js_1.SIFT_DEFAULT_LLAMA_BASE_URL,
            NumCtx: constants_js_1.SIFT_DEFAULT_NUM_CTX,
            ModelPath: constants_js_1.SIFT_DEFAULT_LLAMA_MODEL_PATH,
            Temperature: 0.7,
            TopP: 0.8,
            TopK: 20,
            MinP: 0.0,
            PresencePenalty: 1.5,
            RepetitionPenalty: 1.0,
            MaxTokens: 15_000,
            GpuLayers: 999,
            Threads: -1,
            FlashAttention: true,
            ParallelSlots: 1,
            Reasoning: 'off',
        },
        Runtime: {
            Model: constants_js_1.SIFT_DEFAULT_LLAMA_MODEL,
            LlamaCpp: {
                BaseUrl: constants_js_1.SIFT_DEFAULT_LLAMA_BASE_URL,
                NumCtx: constants_js_1.SIFT_DEFAULT_NUM_CTX,
                ModelPath: constants_js_1.SIFT_DEFAULT_LLAMA_MODEL_PATH,
                Temperature: 0.7,
                TopP: 0.8,
                TopK: 20,
                MinP: 0.0,
                PresencePenalty: 1.5,
                RepetitionPenalty: 1.0,
                MaxTokens: 15_000,
                GpuLayers: 999,
                Threads: -1,
                FlashAttention: true,
                ParallelSlots: 1,
                Reasoning: 'off',
            },
        },
        Thresholds: {
            MinCharactersForSummary: 500,
            MinLinesForSummary: 16,
        },
        Interactive: {
            Enabled: true,
            WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
            IdleTimeoutMs: 900_000,
            MaxTranscriptCharacters: 60_000,
            TranscriptRetention: true,
        },
        Server: {
            LlamaCpp: {
                StartupScript: constants_js_1.SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
                ShutdownScript: constants_js_1.SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
                StartupTimeoutMs: 600_000,
                HealthcheckTimeoutMs: 2_000,
                HealthcheckIntervalMs: 1_000,
                VerboseLogging: false,
                VerboseArgs: [],
            },
        },
        Paths: runtimePaths,
    };
}
