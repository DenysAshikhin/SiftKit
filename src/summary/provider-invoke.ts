import type { SiftConfig } from '../config/index.js';
import { notifyStatusBackend } from '../config/index.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';
import { sleep } from '../lib/time.js';
import { generateLlamaCppResponse, type LlamaCppGenerateResult } from '../providers/llama-cpp.js';
import type { TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
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
  providerDurationMs: number;
  statusRunningMs: number;
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
  statusBackendUrl?: string | null;
  timingRecorder?: TemporaryTimingRecorder | null;
}): Promise<{ text: string; metrics: ProviderSummaryMetrics }> {
  const chunkLabel = options.chunkPath ?? (
    options.chunkIndex !== null && options.chunkTotal !== null ? `${options.chunkIndex}/${options.chunkTotal}` : 'none'
  );
  traceSummary(
    `notify running=true phase=${options.phase} chunk=${chunkLabel} raw_chars=${options.rawInputCharacterCount} `
    + `chunk_chars=${options.chunkInputCharacterCount} prompt_chars=${options.promptCharacterCount}`
  );
  const statusRunningStartedAt = Date.now();
  const notifyRunningSpan = options.timingRecorder?.start('summary.status.notify_running', {
    phase: options.phase,
    chunk: chunkLabel,
    promptChars: options.promptCharacterCount,
  });
  try {
    await notifyStatusBackend({
      running: true,
      taskKind: 'summary',
      statusBackendUrl: options.statusBackendUrl,
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
    notifyRunningSpan?.end({ ok: true });
  } catch {
    notifyRunningSpan?.end({ ok: false });
    traceSummary(`notify running=true failed phase=${options.phase} chunk=${chunkLabel} request_id=${options.requestId}`);
  }
  const statusRunningMs = Date.now() - statusRunningStartedAt;
  const startedAt = Date.now();
  let inputTokens: number | null = null;
  let outputCharacterCount: number | null = null;
  let outputTokens: number | null = null;
  let thinkingTokens: number | null = null;
  let promptCacheTokens: number | null = null;
  let promptEvalTokens: number | null = null;
  try {
    if (options.backend === 'mock') {
      const mockSpan = options.timingRecorder?.start('summary.provider.mock', {
        phase: options.phase,
        chunk: chunkLabel,
      });
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
      mockSpan?.end({ outputChars: mockSummary.length });
      outputCharacterCount = mockSummary.length;
      const providerDurationMs = Date.now() - startedAt;
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
          requestDurationMs: providerDurationMs,
          providerDurationMs,
          statusRunningMs,
        },
      };
    }

    traceSummary(
      `provider start backend=${options.backend} model=${options.model} phase=${options.phase} `
      + `chunk=${chunkLabel} timeout_s=${options.requestTimeoutSeconds ?? 600}`
    );
    const llamaSpan = options.timingRecorder?.start('summary.llama.request', {
      phase: options.phase,
      chunk: chunkLabel,
      promptTokenCount: options.promptTokenCount ?? -1,
    });
    let response: LlamaCppGenerateResult;
    try {
      response = await generateLlamaCppResponse({
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
    } finally {
      llamaSpan?.end();
    }
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
    const providerDurationMs = Date.now() - startedAt;
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
        requestDurationMs: providerDurationMs,
        providerDurationMs,
        statusRunningMs,
      },
    };
  } catch (error) {
    traceSummary(`notify running=false phase=${options.phase} chunk=${chunkLabel} duration_ms=${Date.now() - startedAt}`);
    throw error;
  }
}
