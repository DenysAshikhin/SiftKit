import {
  SIFTKIT_VERSION,
  SIFT_DEFAULT_LLAMA_BASE_URL,
  SIFT_DEFAULT_LLAMA_MODEL,
  SIFT_DEFAULT_LLAMA_MODEL_PATH,
  SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
  SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_NUM_CTX,
  SIFT_DEFAULT_PROMPT_PREFIX,
} from './constants.js';
import { initializeRuntime } from './paths.js';
import type { SiftConfig } from './types.js';

export function getDefaultConfigObject(): SiftConfig {
  const runtimePaths = initializeRuntime();
  return {
    Version: SIFTKIT_VERSION,
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    PromptPrefix: SIFT_DEFAULT_PROMPT_PREFIX,
    LlamaCpp: {
      BaseUrl: SIFT_DEFAULT_LLAMA_BASE_URL,
      NumCtx: SIFT_DEFAULT_NUM_CTX,
      ModelPath: SIFT_DEFAULT_LLAMA_MODEL_PATH,
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
      Model: SIFT_DEFAULT_LLAMA_MODEL,
      LlamaCpp: {
        BaseUrl: SIFT_DEFAULT_LLAMA_BASE_URL,
        NumCtx: SIFT_DEFAULT_NUM_CTX,
        ModelPath: SIFT_DEFAULT_LLAMA_MODEL_PATH,
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
        StartupScript: SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
        ShutdownScript: SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
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
