import type { SiftConfig } from '../config/index.js';
import { notifyStatusBackend } from '../config/index.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';
import { sleep } from '../lib/time.js';
import { generateLlamaCppResponse } from '../providers/llama-cpp.js';
import { getMockSummary } from './mock.js';
import { appendTestProviderEvent, traceSummary } from './artifacts.js';
import type {
  SummaryPhase,
  SummaryRequest,
} from './types.js';

export type ProviderSummaryMetrics = {
  promptCharacterCount: number;
  promptTokenCount: number | null;
  rawInputCharacterCount: number;
  chunkInputCharacterCount: number;
  inputTokens: number | null;
  outputCharacterCount: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  requestDurationMs: number;
};

export async function invokeProviderSummary(options: {
  requestId: string;
  slotId: number | null;
  backend: string;
  config: SiftConfig;
  model: string;
  prompt: string;
  question: string;
  promptCharacterCount: number;
  promptTokenCount: number | null;
  rawInputCharacterCount: number;
  chunkInputCharacterCount: number;
  phase: SummaryPhase;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  reasoningOverride?: 'on' | 'off';
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<{ text: string; metrics: ProviderSummaryMetrics }> {
  const chunkLabel = options.chunkPath ?? (
    options.chunkIndex !== null && options.chunkTotal !== null ? `${options.chunkIndex}/${options.chunkTotal}` : 'none'
  );
  traceSummary(
    `notify running=true phase=${options.phase} chunk=${chunkLabel} raw_chars=${options.rawInputCharacterCount} `
    + `chunk_chars=${options.chunkInputCharacterCount} prompt_chars=${options.promptCharacterCount}`
  );
  await notifyStatusBackend({
    running: true,
    taskKind: 'summary',
    requestId: options.requestId,
    promptCharacterCount: options.promptCharacterCount,
    promptTokenCount: options.promptTokenCount,
    rawInputCharacterCount: options.rawInputCharacterCount,
    chunkInputCharacterCount: options.chunkInputCharacterCount,
    budgetSource: options.config.Effective?.BudgetSource ?? null,
    inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
    chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
    phase: options.phase,
    chunkIndex: options.chunkIndex,
    chunkTotal: options.chunkTotal,
    chunkPath: options.chunkPath,
  });
  const startedAt = Date.now();
  let inputTokens: number | null = null;
  let outputCharacterCount: number | null = null;
  let outputTokens: number | null = null;
  let thinkingTokens: number | null = null;
  let promptCacheTokens: number | null = null;
  let promptEvalTokens: number | null = null;
  try {
    if (options.backend === 'mock') {
      const rawSleep = process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
      const sleepMs = rawSleep ? Number.parseInt(rawSleep, 10) : 0;
      if (Number.isFinite(sleepMs) && sleepMs > 0) {
        await sleep(sleepMs);
      }
      appendTestProviderEvent({
        backend: options.backend,
        model: options.model,
        phase: options.phase,
        question: options.question,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
      });
      const mockSummary = getMockSummary(options.prompt, options.question, options.phase);
      outputCharacterCount = mockSummary.length;
      return {
        text: mockSummary,
        metrics: {
          promptCharacterCount: options.promptCharacterCount,
          promptTokenCount: options.promptTokenCount,
          rawInputCharacterCount: options.rawInputCharacterCount,
          chunkInputCharacterCount: options.chunkInputCharacterCount,
          inputTokens,
          outputCharacterCount,
          outputTokens,
          thinkingTokens,
          promptCacheTokens,
          promptEvalTokens,
          requestDurationMs: Date.now() - startedAt,
        },
      };
    }

    traceSummary(
      `provider start backend=${options.backend} model=${options.model} phase=${options.phase} `
      + `chunk=${chunkLabel} timeout_s=${options.requestTimeoutSeconds ?? 600}`
    );
    const response = await generateLlamaCppResponse({
      config: options.config,
      model: options.model,
      prompt: options.prompt,
      promptTokenCount: options.promptTokenCount,
      timeoutSeconds: options.requestTimeoutSeconds ?? 600,
      slotId: options.slotId ?? undefined,
      reasoningOverride: options.reasoningOverride,
      structuredOutput: {
        kind: 'siftkit-decision-json',
        allowUnsupportedInput: options.backend !== 'llama.cpp' || options.phase === 'leaf' && options.chunkPath !== null,
      },
      overrides: options.llamaCppOverrides,
    });
    inputTokens = getProcessedPromptTokens(
      response.usage?.promptTokens ?? null,
      response.usage?.promptCacheTokens ?? null,
      response.usage?.promptEvalTokens ?? null,
    );
    outputCharacterCount = response.text.length;
    outputTokens = response.usage?.completionTokens ?? null;
    thinkingTokens = response.usage?.thinkingTokens ?? null;
    promptCacheTokens = response.usage?.promptCacheTokens ?? null;
    promptEvalTokens = response.usage?.promptEvalTokens ?? null;
    traceSummary(
      `provider done phase=${options.phase} chunk=${chunkLabel} output_chars=${outputCharacterCount} `
      + `output_tokens=${outputTokens ?? 'null'} thinking_tokens=${thinkingTokens ?? 'null'}`
    );
    return {
      text: response.text.trim(),
      metrics: {
        promptCharacterCount: options.promptCharacterCount,
        promptTokenCount: options.promptTokenCount,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
        inputTokens,
        outputCharacterCount,
        outputTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
        requestDurationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    traceSummary(`notify running=false phase=${options.phase} chunk=${chunkLabel} duration_ms=${Date.now() - startedAt}`);
    throw error;
  }
}
