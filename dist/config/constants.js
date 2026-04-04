"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUNTIME_OWNED_LLAMA_CPP_KEYS = exports.SIFT_DEFAULT_PROMPT_PREFIX = exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = exports.SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT = exports.SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = exports.SIFT_DEFAULT_LLAMA_MODEL_PATH = exports.SIFT_DEFAULT_LLAMA_BASE_URL = exports.SIFT_DEFAULT_LLAMA_MODEL = exports.SIFT_PREVIOUS_DEFAULT_MODEL = exports.SIFT_PREVIOUS_DEFAULT_NUM_CTX = exports.SIFT_LEGACY_DERIVED_NUM_CTX = exports.SIFT_LEGACY_DEFAULT_NUM_CTX = exports.SIFT_DEFAULT_NUM_CTX = exports.SIFTKIT_VERSION = void 0;
exports.SIFTKIT_VERSION = '0.1.0';
exports.SIFT_DEFAULT_NUM_CTX = 128_000;
exports.SIFT_LEGACY_DEFAULT_NUM_CTX = 16_384;
exports.SIFT_LEGACY_DERIVED_NUM_CTX = 32_000;
exports.SIFT_PREVIOUS_DEFAULT_NUM_CTX = 50_000;
exports.SIFT_PREVIOUS_DEFAULT_MODEL = 'qwen3.5-4b-q8_0';
exports.SIFT_DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
exports.SIFT_DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
exports.SIFT_DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
exports.SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-35B-4bit-150k-no-thinking.ps1';
exports.SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k.ps1';
exports.SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT = 'D:\\personal\\models\\Start-Qwen35-9B-Q8-200k-thinking.ps1';
exports.SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\start-qwen35-9b-q8-200k-thinking-managed.ps1';
exports.SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\scripts\\stop-llama-server.ps1';
exports.SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = 32_000;
exports.SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = 2.5;
exports.SIFT_DEFAULT_PROMPT_PREFIX = 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.';
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
