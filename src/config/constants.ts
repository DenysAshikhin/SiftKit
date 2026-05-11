export const SIFTKIT_VERSION = '0.1.0';
export const SIFT_DEFAULT_NUM_CTX = 128_000;
export const SIFT_LEGACY_DEFAULT_NUM_CTX = 16_384;
export const SIFT_LEGACY_DERIVED_NUM_CTX = 32_000;
export const SIFT_PREVIOUS_DEFAULT_NUM_CTX = 50_000;
export const SIFT_PREVIOUS_DEFAULT_MODEL = 'qwen3.5-4b-q8_0';
export const SIFT_DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const SIFT_DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
export const SIFT_DEFAULT_LLAMA_MODEL_PATH = 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const SIFT_DEFAULT_LLAMA_EXECUTABLE_PATH = 'C:\\Users\\denys\\Documents\\GitHub\\llamacpp\\llama-server.exe';
export const SIFT_DEFAULT_LLAMA_BIND_HOST = '127.0.0.1';
export const SIFT_DEFAULT_LLAMA_PORT = 8097;
export const SIFT_DEFAULT_LLAMA_GPU_LAYERS = 999;
export const SIFT_DEFAULT_LLAMA_BATCH_SIZE = 512;
export const SIFT_DEFAULT_LLAMA_UBATCH_SIZE = 512;
export const SIFT_DEFAULT_LLAMA_CACHE_RAM = 8192;
export const SIFT_DEFAULT_LLAMA_KV_CACHE_QUANTIZATION = 'f16';
export const SIFT_DEFAULT_LLAMA_REASONING_BUDGET = 10_000;
export const SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE = 'Thinking budget exhausted. You have to provide the answer now.';
export const SIFT_DEFAULT_LLAMA_SLEEP_IDLE_SECONDS = 600;
export const SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS = 32_000;
export const SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN = 2.5;
export const SIFT_DEFAULT_PROMPT_PREFIX = 'Preserve exact technical anchors from the input when they matter: file paths, function names, symbols, commands, error text, and any line numbers or code references that are already present. Quote short code fragments exactly when that precision changes the meaning. Do not invent locations or line numbers that are not in the input.';

export const RUNTIME_OWNED_LLAMA_CPP_KEYS = [
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
] as const;

export type RuntimeOwnedLlamaCppKey = typeof RUNTIME_OWNED_LLAMA_CPP_KEYS[number];
