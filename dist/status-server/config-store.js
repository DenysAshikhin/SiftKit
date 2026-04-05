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
exports.RUNTIME_OWNED_LLAMA_CPP_KEYS = exports.DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS = exports.DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS = exports.DEFAULT_LLAMA_STARTUP_TIMEOUT_MS = exports.MAX_LLAMA_STARTUP_TIMEOUT_MS = exports.DEFAULT_LLAMA_SHUTDOWN_SCRIPT = exports.DEFAULT_LLAMA_STARTUP_SCRIPT = exports.BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.DEFAULT_LLAMA_MODEL_PATH = exports.DEFAULT_LLAMA_BASE_URL = exports.DEFAULT_LLAMA_MODEL = void 0;
exports.getDefaultConfig = getDefaultConfig;
exports.normalizeWindowsPath = normalizeWindowsPath;
exports.isLegacyManagedStartupScriptPath = isLegacyManagedStartupScriptPath;
exports.mergeConfig = mergeConfig;
exports.normalizeConfig = normalizeConfig;
exports.readConfig = readConfig;
exports.writeConfig = writeConfig;
exports.getFinitePositiveInteger = getFinitePositiveInteger;
exports.getManagedStartupTimeoutMs = getManagedStartupTimeoutMs;
exports.getCompatRuntimeLlamaCpp = getCompatRuntimeLlamaCpp;
exports.getLlamaBaseUrl = getLlamaBaseUrl;
exports.getManagedLlamaConfig = getManagedLlamaConfig;
const fs = __importStar(require("node:fs"));
const paths_js_1 = require("../lib/paths.js");
const http_utils_js_1 = require("./http-utils.js");
exports.DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
exports.DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
exports.DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
exports.PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-35B-4bit-150k-no-thinking.ps1';
exports.FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k.ps1';
exports.BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k-thinking.ps1';
exports.DEFAULT_LLAMA_STARTUP_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\start-qwen35-9b-q8-200k-thinking-managed.ps1';
exports.DEFAULT_LLAMA_SHUTDOWN_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\stop-llama-server.ps1';
exports.MAX_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
exports.DEFAULT_LLAMA_STARTUP_TIMEOUT_MS = 600_000;
exports.DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS = 2_000;
exports.DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS = 1_000;
exports.RUNTIME_OWNED_LLAMA_CPP_KEYS = [
    'BaseUrl',
    'NumCtx',
    'ModelPath',
    'Temperature',
    'TopP',
    'TopK',
    'MinP',
    'PresencePenalty',
    'RepetitionPenalty',
    'MaxTokens',
    'GpuLayers',
    'Threads',
    'FlashAttention',
    'ParallelSlots',
    'Reasoning',
];
function getDefaultConfig() {
    return {
        Version: '0.1.0',
        Backend: 'llama.cpp',
        PolicyMode: 'conservative',
        RawLogRetention: true,
        PromptPrefix: 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.',
        LlamaCpp: {
            BaseUrl: exports.DEFAULT_LLAMA_BASE_URL,
            NumCtx: 150000,
            ModelPath: exports.DEFAULT_LLAMA_MODEL_PATH,
            Temperature: 0.7,
            TopP: 0.8,
            TopK: 20,
            MinP: 0.0,
            PresencePenalty: 1.5,
            RepetitionPenalty: 1.0,
            MaxTokens: 15000,
            FlashAttention: true,
            ParallelSlots: 1,
            Reasoning: 'off',
        },
        Runtime: {
            Model: exports.DEFAULT_LLAMA_MODEL,
            LlamaCpp: {
                BaseUrl: exports.DEFAULT_LLAMA_BASE_URL,
                NumCtx: 150000,
                ModelPath: exports.DEFAULT_LLAMA_MODEL_PATH,
                Temperature: 0.7,
                TopP: 0.8,
                TopK: 20,
                MinP: 0.0,
                PresencePenalty: 1.5,
                RepetitionPenalty: 1.0,
                MaxTokens: 15000,
                FlashAttention: true,
                ParallelSlots: 1,
                Reasoning: 'off',
            },
        },
        Thresholds: {
            MinCharactersForSummary: 500,
            MinLinesForSummary: 16,
            ChunkThresholdRatio: 1.0,
        },
        Interactive: {
            Enabled: true,
            WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
            IdleTimeoutMs: 900000,
            MaxTranscriptCharacters: 60000,
            TranscriptRetention: true,
        },
        Server: {
            LlamaCpp: {
                StartupScript: exports.DEFAULT_LLAMA_STARTUP_SCRIPT,
                ShutdownScript: exports.DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
                StartupTimeoutMs: exports.DEFAULT_LLAMA_STARTUP_TIMEOUT_MS,
                HealthcheckTimeoutMs: exports.DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS,
                HealthcheckIntervalMs: exports.DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS,
                VerboseLogging: false,
                VerboseArgs: [],
            },
        },
    };
}
function normalizeWindowsPath(value) {
    return (0, paths_js_1.normalizeWindowsPath)(String(value || ''));
}
function isLegacyManagedStartupScriptPath(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return false;
    }
    const normalized = normalizeWindowsPath(value.trim());
    return normalized === normalizeWindowsPath(exports.PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT)
        || normalized === normalizeWindowsPath(exports.FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT)
        || normalized === normalizeWindowsPath(exports.BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT);
}
function mergeConfig(baseValue, patchValue) {
    if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
        return patchValue.slice();
    }
    if (baseValue &&
        patchValue &&
        typeof baseValue === 'object' &&
        typeof patchValue === 'object' &&
        !Array.isArray(baseValue) &&
        !Array.isArray(patchValue)) {
        const merged = { ...baseValue };
        for (const [key, value] of Object.entries(patchValue)) {
            if (key === 'Paths') {
                continue;
            }
            merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
        }
        return merged;
    }
    return patchValue;
}
function normalizeConfig(input) {
    const merged = mergeConfig(getDefaultConfig(), input || {});
    if (merged.Backend === 'ollama') {
        merged.Backend = 'llama.cpp';
    }
    merged.LlamaCpp = (merged.LlamaCpp && typeof merged.LlamaCpp === 'object') ? merged.LlamaCpp : {};
    merged.Runtime = (merged.Runtime && typeof merged.Runtime === 'object') ? merged.Runtime : {};
    const runtime = merged.Runtime;
    runtime.LlamaCpp = (runtime.LlamaCpp && typeof runtime.LlamaCpp === 'object') ? runtime.LlamaCpp : {};
    const runtimeLlama = runtime.LlamaCpp;
    const ollama = merged.Ollama;
    if (ollama) {
        if (ollama.BaseUrl !== undefined) {
            runtimeLlama.BaseUrl = runtimeLlama.BaseUrl ?? ollama.BaseUrl;
        }
        if (ollama.NumCtx !== undefined) {
            runtimeLlama.NumCtx = runtimeLlama.NumCtx ?? Number(ollama.NumCtx);
        }
        if (ollama.Temperature !== undefined) {
            runtimeLlama.Temperature = runtimeLlama.Temperature ?? Number(ollama.Temperature);
        }
        if (ollama.TopP !== undefined) {
            runtimeLlama.TopP = runtimeLlama.TopP ?? Number(ollama.TopP);
        }
        if (ollama.TopK !== undefined) {
            runtimeLlama.TopK = runtimeLlama.TopK ?? Number(ollama.TopK);
        }
        if (ollama.MinP !== undefined) {
            runtimeLlama.MinP = runtimeLlama.MinP ?? Number(ollama.MinP);
        }
        if (ollama.PresencePenalty !== undefined) {
            runtimeLlama.PresencePenalty = runtimeLlama.PresencePenalty ?? Number(ollama.PresencePenalty);
        }
        if (ollama.RepetitionPenalty !== undefined) {
            runtimeLlama.RepetitionPenalty = runtimeLlama.RepetitionPenalty ?? Number(ollama.RepetitionPenalty);
        }
        if (Object.prototype.hasOwnProperty.call(ollama, 'NumPredict')) {
            runtimeLlama.MaxTokens = runtimeLlama.MaxTokens ?? ollama.NumPredict;
        }
    }
    delete merged.Ollama;
    delete merged.Paths;
    merged.Server = (merged.Server && typeof merged.Server === 'object') ? merged.Server : {};
    const server = merged.Server;
    server.LlamaCpp = (server.LlamaCpp && typeof server.LlamaCpp === 'object') ? server.LlamaCpp : {};
    const serverLlama = server.LlamaCpp;
    if (typeof merged.Model === 'string' && merged.Model.trim() && !runtime.Model) {
        runtime.Model = merged.Model;
    }
    delete merged.Model;
    if ((!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) && typeof runtime.PromptPrefix === 'string' && runtime.PromptPrefix.trim()) {
        merged.PromptPrefix = runtime.PromptPrefix;
    }
    delete runtime.PromptPrefix;
    if (!merged.PromptPrefix || !String(merged.PromptPrefix).trim()) {
        merged.PromptPrefix = getDefaultConfig().PromptPrefix;
    }
    if (merged.Thresholds && typeof merged.Thresholds === 'object') {
        delete merged.Thresholds.MaxInputCharacters;
    }
    const llamaCpp = merged.LlamaCpp;
    if (llamaCpp && typeof llamaCpp === 'object') {
        for (const key of exports.RUNTIME_OWNED_LLAMA_CPP_KEYS) {
            if (Object.prototype.hasOwnProperty.call(llamaCpp, key)) {
                if (!Object.prototype.hasOwnProperty.call(runtimeLlama, key)) {
                    runtimeLlama[key] = llamaCpp[key];
                }
                delete llamaCpp[key];
            }
        }
    }
    if (!Object.prototype.hasOwnProperty.call(serverLlama, 'StartupScript')) {
        serverLlama.StartupScript = null;
    }
    if (isLegacyManagedStartupScriptPath(serverLlama.StartupScript)) {
        serverLlama.StartupScript = exports.DEFAULT_LLAMA_STARTUP_SCRIPT;
    }
    if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ShutdownScript')) {
        serverLlama.ShutdownScript = null;
    }
    if (!Object.prototype.hasOwnProperty.call(serverLlama, 'StartupTimeoutMs')) {
        serverLlama.StartupTimeoutMs = exports.DEFAULT_LLAMA_STARTUP_TIMEOUT_MS;
    }
    if (!Object.prototype.hasOwnProperty.call(serverLlama, 'HealthcheckTimeoutMs')) {
        serverLlama.HealthcheckTimeoutMs = exports.DEFAULT_LLAMA_HEALTHCHECK_TIMEOUT_MS;
    }
    if (!Object.prototype.hasOwnProperty.call(serverLlama, 'HealthcheckIntervalMs')) {
        serverLlama.HealthcheckIntervalMs = exports.DEFAULT_LLAMA_HEALTHCHECK_INTERVAL_MS;
    }
    if (!Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseLogging')) {
        serverLlama.VerboseLogging = false;
    }
    if (!Object.prototype.hasOwnProperty.call(serverLlama, 'VerboseArgs')) {
        serverLlama.VerboseArgs = [];
    }
    serverLlama.VerboseLogging = Boolean(serverLlama.VerboseLogging);
    serverLlama.VerboseArgs = Array.isArray(serverLlama.VerboseArgs)
        ? serverLlama.VerboseArgs
            .filter((value) => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim())
        : [];
    return merged;
}
function readConfig(configPath) {
    if (!fs.existsSync(configPath)) {
        return normalizeConfig({});
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return normalizeConfig(parsed);
    }
    catch {
        return normalizeConfig({});
    }
}
function writeConfig(configPath, config) {
    (0, http_utils_js_1.writeText)(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}
function getFinitePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function getManagedStartupTimeoutMs(value, fallback) {
    return Math.min(getFinitePositiveInteger(value, fallback), exports.MAX_LLAMA_STARTUP_TIMEOUT_MS);
}
function getCompatRuntimeLlamaCpp(config) {
    const cfg = (config ?? {});
    const runtime = (cfg.Runtime ?? {});
    const runtimeLlama = runtime.LlamaCpp;
    if (runtimeLlama && typeof runtimeLlama === 'object') {
        return runtimeLlama;
    }
    const llama = cfg.LlamaCpp;
    if (llama && typeof llama === 'object') {
        return llama;
    }
    return {};
}
function getLlamaBaseUrl(config) {
    const baseUrl = getCompatRuntimeLlamaCpp(config).BaseUrl;
    return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : null;
}
function getManagedLlamaConfig(config) {
    const defaults = getDefaultConfig().Server.LlamaCpp;
    const cfg = (config ?? {});
    const srv = (cfg.Server ?? {});
    const serverLlama = (srv.LlamaCpp ?? {});
    return {
        StartupScript: typeof serverLlama.StartupScript === 'string' && serverLlama.StartupScript.trim() ? serverLlama.StartupScript.trim() : null,
        ShutdownScript: typeof serverLlama.ShutdownScript === 'string' && serverLlama.ShutdownScript.trim() ? serverLlama.ShutdownScript.trim() : null,
        StartupTimeoutMs: getManagedStartupTimeoutMs(serverLlama.StartupTimeoutMs, Number(defaults.StartupTimeoutMs)),
        HealthcheckTimeoutMs: getFinitePositiveInteger(serverLlama.HealthcheckTimeoutMs, Number(defaults.HealthcheckTimeoutMs)),
        HealthcheckIntervalMs: getFinitePositiveInteger(serverLlama.HealthcheckIntervalMs, Number(defaults.HealthcheckIntervalMs)),
        VerboseLogging: Boolean(serverLlama.VerboseLogging),
        VerboseArgs: Array.isArray(serverLlama.VerboseArgs)
            ? serverLlama.VerboseArgs
                .filter((value) => typeof value === 'string' && value.trim().length > 0)
                .map((value) => value.trim())
            : [],
    };
}
