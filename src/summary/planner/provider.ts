import type { SiftConfig } from '../../config/index.js';
import { notifyStatusBackend } from '../../config/index.js';
import { getProcessedPromptTokens } from '../../lib/provider-helpers.js';
import {
  generateLlamaCppChatResponse,
  type LlamaCppChatMessage,
} from '../../providers/llama-cpp.js';
import { traceSummary } from '../artifacts.js';
import type {
  PlannerToolDefinition,
  SummaryRequest,
} from '../types.js';

export async function invokePlannerProviderAction(options: {
  requestId: string;
  slotId: number | null;
  config: SiftConfig;
  model: string;
  messages: LlamaCppChatMessage[];
  promptText: string;
  promptTokenCount: number;
  rawInputCharacterCount: number;
  chunkInputCharacterCount: number;
  toolDefinitions: PlannerToolDefinition[];
  reasoningOverride?: 'on' | 'off';
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
  statusBackendUrl?: string | null;
}): Promise<{
  text: string;
  reasoningText: string | null;
  inputTokens: number | null;
  outputCharacterCount: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  requestDurationMs: number;
  providerDurationMs: number;
  statusRunningMs: number;
}> {
  traceSummary(
    `notify running=true phase=planner chunk=none raw_chars=${options.rawInputCharacterCount} `
    + `chunk_chars=${options.chunkInputCharacterCount} prompt_chars=${options.promptText.length}`
  );
  const statusRunningStartedAt = Date.now();
  try {
    await notifyStatusBackend({
      running: true,
      taskKind: 'summary',
      statusBackendUrl: options.statusBackendUrl,
      requestId: options.requestId,
      promptCharacterCount: options.promptText.length,
      promptTokenCount: options.promptTokenCount,
      rawInputCharacterCount: options.rawInputCharacterCount,
      chunkInputCharacterCount: options.chunkInputCharacterCount,
      budgetSource: options.config.Effective?.BudgetSource ?? null,
      inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
      chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
      phase: 'planner',
    });
  } catch {
    traceSummary(`notify running=true failed phase=planner chunk=none request_id=${options.requestId}`);
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
    const response = await generateLlamaCppChatResponse({
      config: options.config,
      model: options.model,
      messages: options.messages,
      timeoutSeconds: options.requestTimeoutSeconds ?? 600,
      slotId: options.slotId ?? undefined,
      cachePrompt: true,
      tools: options.toolDefinitions,
      structuredOutput: {
        kind: 'siftkit-planner-action-json',
        tools: options.toolDefinitions,
      },
      reasoningOverride: options.reasoningOverride,
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
    const providerDurationMs = Date.now() - startedAt;
    return {
      text: response.text,
      reasoningText: response.reasoningText,
      inputTokens,
      outputCharacterCount,
      outputTokens,
      thinkingTokens,
      promptCacheTokens,
      promptEvalTokens,
      requestDurationMs: providerDurationMs,
      providerDurationMs,
      statusRunningMs,
    };
  } catch (error) {
    traceSummary(`notify running=false phase=planner chunk=none duration_ms=${Date.now() - startedAt}`);
    try {
      await notifyStatusBackend({
        running: false,
        taskKind: 'summary',
        requestId: options.requestId,
        statusBackendUrl: options.statusBackendUrl,
        promptCharacterCount: options.promptText.length,
        inputTokens,
        outputCharacterCount,
        outputTokens,
        thinkingTokens,
        promptCacheTokens,
        promptEvalTokens,
        requestDurationMs: Date.now() - startedAt,
      });
    } catch {
      traceSummary(`notify running=false failed phase=planner chunk=none request_id=${options.requestId}`);
    }
    throw error;
  }
}
