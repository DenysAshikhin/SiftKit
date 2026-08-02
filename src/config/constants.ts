import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findNearestSiftKitRepoRoot, moduleDirname } from '../lib/paths.js';
import { z } from '../lib/zod.js';

const PackageJsonSchema = z.object({ version: z.string() });

// The compiled copies of this module sit at different depths under the output
// root: dist/config/constants.js after scripts/sync-dist-runtime.js flattens the
// tree, and dist/src/config/constants.js in the tree it flattens from, which
// dist/scripts/** imports. A fixed '..','..' hop is only correct for one of
// them, and the wrong one lands on dist/package.json, which has no version.
// Walk up to the nearest package.json named "siftkit" instead.
const moduleDirectory = moduleDirname(import.meta.url);
const packageRoot = findNearestSiftKitRepoRoot(moduleDirectory);
if (!packageRoot) {
  throw new Error(
    `No SiftKit package.json found above ${moduleDirectory}. `
    + 'The SiftKit install is incomplete: its package.json must be reachable from the compiled output.',
  );
}

const packageJson = PackageJsonSchema.parse(JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
));

export const SIFTKIT_VERSION = packageJson.version;
export const SIFT_DEFAULT_NUM_CTX = 128_000;
export const SIFT_DEFAULT_LLAMA_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
export const SIFT_DEFAULT_STATUS_PORT = 4765;
export const SIFT_DEFAULT_LLAMA_BASE_URL = 'http://127.0.0.1:8097';
export const SIFT_DEFAULT_LLAMA_BIND_HOST = '127.0.0.1';
export const SIFT_DEFAULT_LLAMA_PORT = 8097;
export const SIFT_DEFAULT_LLAMA_GPU_LAYERS = 999;
export const SIFT_DEFAULT_LLAMA_BATCH_SIZE = 512;
export const SIFT_DEFAULT_LLAMA_UBATCH_SIZE = 512;
export const SIFT_DEFAULT_LLAMA_CACHE_RAM = 8192;
/** MB of host RAM exllamav3 reserves for recurrent (linear-attention) states; mirrors TabbyAPI's own default. */
export const SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM = 4096;
export const SIFT_DEFAULT_LLAMA_KV_CACHE_QUANTIZATION = 'f16';
export const SIFT_DEFAULT_LLAMA_REASONING_BUDGET = 10_000;
export const SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE = 'Thinking budget exhausted. You have to provide the answer now.';
export const SIFT_DEFAULT_LLAMA_SLEEP_IDLE_SECONDS = 600;
export const SIFT_DEFAULT_VISION_ENABLED = false;
export const SIFT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const SIFT_IMAGE_TOKEN_ESTIMATE = 2048;
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
