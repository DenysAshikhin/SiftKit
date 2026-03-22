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
const fs = __importStar(require("node:fs"));
const config_js_1 = require("./config.js");
const llama_cpp_js_1 = require("./providers/llama-cpp.js");
function parseArgs(argv) {
    const parsed = new Map();
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            continue;
        }
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            parsed.set(key, 'true');
            continue;
        }
        parsed.set(key, next);
        i += 1;
    }
    return parsed;
}
function getRequiredArg(args, key) {
    const value = args.get(key);
    if (!value) {
        throw new Error(`Missing required argument: --${key}`);
    }
    return value;
}
function getOptionalNumber(args, key) {
    const value = args.get(key);
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric argument for --${key}: ${value}`);
    }
    return parsed;
}
async function main() {
    const command = process.argv[2];
    if (command !== 'generate') {
        throw new Error('Only the generate command is supported.');
    }
    const args = parseArgs(process.argv.slice(3));
    const promptFile = getRequiredArg(args, 'prompt-file');
    const prompt = fs.readFileSync(promptFile, 'utf8');
    const maxTokens = getOptionalNumber(args, 'max-tokens');
    const config = {
        Version: '0.1.0',
        Backend: 'llama.cpp',
        Model: getRequiredArg(args, 'model'),
        PolicyMode: 'conservative',
        RawLogRetention: true,
        LlamaCpp: {
            BaseUrl: getRequiredArg(args, 'base-url'),
            NumCtx: Number(getRequiredArg(args, 'num-ctx')),
            Temperature: Number(getRequiredArg(args, 'temperature')),
            TopP: Number(getRequiredArg(args, 'top-p')),
            TopK: Number(getRequiredArg(args, 'top-k')),
            MinP: Number(getRequiredArg(args, 'min-p')),
            PresencePenalty: Number(getRequiredArg(args, 'presence-penalty')),
            RepetitionPenalty: Number(getRequiredArg(args, 'repeat-penalty')),
            ...(maxTokens === null ? {} : { MaxTokens: maxTokens }),
        },
        Thresholds: {
            MinCharactersForSummary: 500,
            MinLinesForSummary: 16,
            ChunkThresholdRatio: 1.0,
        },
        Interactive: {
            Enabled: true,
            WrappedCommands: [],
            IdleTimeoutMs: 900000,
            MaxTranscriptCharacters: 60000,
            TranscriptRetention: true,
        },
    };
    const response = await (0, llama_cpp_js_1.generateLlamaCppResponse)({
        config,
        model: (0, config_js_1.getConfiguredModel)(config),
        prompt,
        timeoutSeconds: Number(getRequiredArg(args, 'timeout-seconds')),
    });
    process.stdout.write(JSON.stringify({ response: response.text, usage: response.usage }));
}
void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
