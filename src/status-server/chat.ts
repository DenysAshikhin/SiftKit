import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import type { Dict } from '../lib/types.js';
import {
  type ChatSession,
  estimateTokenCount,
  saveChatSession,
} from '../state/chat-sessions.js';
import { requestJsonFull } from '../lib/http.js';
import {
  DEFAULT_LLAMA_MODEL,
  getLlamaBaseUrl,
  getCompatRuntimeLlamaCpp,
} from './config-store.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';

export function buildContextUsage(session: ChatSession): Dict {
  const contextWindowTokens = Math.max(1, Number(session.contextWindowTokens || 150000));
  const estimatedTokenFallbackTokens = Array.isArray(session.messages)
    ? session.messages.reduce((sum: number, message: Dict) => {
      const inputTokens = Number(message.inputTokensEstimate || 0);
      const outputTokens = Number(message.outputTokensEstimate || 0);
      const thinkingTokens = Number(message.thinkingTokens || 0);
      const inputEstimated = message?.inputTokensEstimated === true ? inputTokens : 0;
      const outputEstimated = message?.outputTokensEstimated === true ? outputTokens : 0;
      const thinkingEstimated = message?.thinkingTokensEstimated === true ? thinkingTokens : 0;
      return sum + inputEstimated + outputEstimated + thinkingEstimated;
    }, 0)
    : 0;
  const chatUsedTokens = Array.isArray(session.messages)
    ? session.messages.reduce((sum: number, message: Dict) => (
      sum
      + Number(message.inputTokensEstimate || 0)
      + Number(message.outputTokensEstimate || 0)
      + Number(message.thinkingTokens || 0)
    ), 0)
    : 0;
  const toolUsedTokens = Array.isArray(session.hiddenToolContexts)
    ? session.hiddenToolContexts.reduce((sum: number, entry: Dict) => sum + (Number(entry?.tokenEstimate) || 0), 0)
    : 0;
  const totalUsedTokens = chatUsedTokens + toolUsedTokens;
  const remainingTokens = Math.max(contextWindowTokens - totalUsedTokens, 0);
  const warnThresholdTokens = Math.max(5000, Math.ceil(contextWindowTokens * 0.1));
  return {
    contextWindowTokens,
    usedTokens: chatUsedTokens,
    chatUsedTokens,
    toolUsedTokens,
    totalUsedTokens,
    remainingTokens,
    warnThresholdTokens,
    shouldCondense: remainingTokens <= warnThresholdTokens,
    estimatedTokenFallbackTokens,
  };
}

export function resolveActiveChatModel(config: Dict | null | undefined, session: ChatSession): string {
  if (typeof session?.model === 'string' && session.model.trim()) {
    return session.model.trim();
  }
  const runtime = (config?.Runtime as Dict | undefined);
  if (typeof runtime?.Model === 'string' && (runtime.Model as string).trim()) {
    return (runtime.Model as string).trim();
  }
  if (typeof config?.Model === 'string' && (config.Model as string).trim()) {
    return (config.Model as string).trim();
  }
  return DEFAULT_LLAMA_MODEL;
}

function getChatUsageValue(value: unknown): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function getTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((part: unknown) => {
      if (part && typeof part === 'object') {
        const partDict = part as Dict;
        if (partDict.type === 'text' || !partDict.type) {
          return String(partDict.text || '');
        }
      }
      return '';
    })
    .join('');
}

function getThinkingTokensFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const usageDict = usage as Dict;
  const completionDetails = usageDict.completion_tokens_details && typeof usageDict.completion_tokens_details === 'object'
    ? usageDict.completion_tokens_details as Dict
    : null;
  const outputDetails = usageDict.output_tokens_details && typeof usageDict.output_tokens_details === 'object'
    ? usageDict.output_tokens_details as Dict
    : null;
  const sources = [completionDetails, outputDetails, usageDict];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const reasoningTokens = getChatUsageValue(source.reasoning_tokens) ?? 0;
    const thinkingTokens = getChatUsageValue(source.thinking_tokens) ?? 0;
    if (
      Object.prototype.hasOwnProperty.call(source, 'reasoning_tokens')
      || Object.prototype.hasOwnProperty.call(source, 'thinking_tokens')
    ) {
      return reasoningTokens + thinkingTokens;
    }
  }
  return null;
}

function getPromptCacheTokensFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const usageDict = usage as Dict;
  const promptDetails = usageDict.prompt_tokens_details && typeof usageDict.prompt_tokens_details === 'object'
    ? usageDict.prompt_tokens_details as Dict
    : null;
  const inputDetails = usageDict.input_tokens_details && typeof usageDict.input_tokens_details === 'object'
    ? usageDict.input_tokens_details as Dict
    : null;
  const sources = [promptDetails, inputDetails, usageDict];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const cachedTokens = getChatUsageValue(source.cached_tokens);
    if (cachedTokens !== null) {
      return cachedTokens;
    }
  }
  return null;
}

function getPromptEvalTokensFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const usageDict = usage as Dict;
  const promptDetails = usageDict.prompt_tokens_details && typeof usageDict.prompt_tokens_details === 'object'
    ? usageDict.prompt_tokens_details as Dict
    : null;
  const inputDetails = usageDict.input_tokens_details && typeof usageDict.input_tokens_details === 'object'
    ? usageDict.input_tokens_details as Dict
    : null;
  const sources = [promptDetails, inputDetails, usageDict];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const explicitPromptEvalTokens = getChatUsageValue(source.prompt_eval_tokens);
    if (explicitPromptEvalTokens !== null) {
      return explicitPromptEvalTokens;
    }
    const explicitNonCachedTokens = getChatUsageValue(source.non_cached_tokens);
    if (explicitNonCachedTokens !== null) {
      return explicitNonCachedTokens;
    }
    const llamaPromptTokens = getChatUsageValue(source.prompt_n);
    if (llamaPromptTokens !== null) {
      return llamaPromptTokens;
    }
  }
  const promptTokens = getChatUsageValue(usageDict.prompt_tokens);
  const promptCacheTokens = getPromptCacheTokensFromUsage(usage);
  if (promptTokens !== null && promptCacheTokens !== null) {
    return Math.max(promptTokens - promptCacheTokens, 0);
  }
  return null;
}

function getChoiceText(choice: Dict | null | undefined): string {
  const message = (choice?.message as Dict | undefined);
  const content = message?.content ?? choice?.text ?? '';
  return getTextContent(content).trim();
}

function getChoiceReasoningText(choice: Dict | null | undefined): string {
  const message = (choice?.message as Dict | undefined);
  const content = message?.reasoning_content ?? '';
  return getTextContent(content).trim();
}

export type ChatCompletionRequest = { url: string; model: string; body: Dict };
type BuildChatOptions = { thinkingEnabled?: boolean; stream?: boolean; promptPrefix?: string };

function shouldReplayReasoningContent(config: Dict): boolean {
  const server = config?.Server && typeof config.Server === 'object' ? config.Server as Dict : null;
  const serverLlama = server?.LlamaCpp && typeof server.LlamaCpp === 'object' ? server.LlamaCpp as Dict : null;
  return serverLlama?.ReasoningContent === true;
}

function shouldPreserveThinking(config: Dict, thinkingEnabled: boolean): boolean {
  if (!thinkingEnabled || !shouldReplayReasoningContent(config)) {
    return false;
  }
  const server = config?.Server && typeof config.Server === 'object' ? config.Server as Dict : null;
  const serverLlama = server?.LlamaCpp && typeof server.LlamaCpp === 'object' ? server.LlamaCpp as Dict : null;
  return serverLlama?.PreserveThinking === true;
}

export function buildChatCompletionRequest(config: Dict, session: ChatSession, userContent: string, options: BuildChatOptions = {}): ChatCompletionRequest {
  const model = resolveActiveChatModel(config, session);
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl) {
    throw new Error('llama.cpp base URL is not configured.');
  }
  const runtimeLlama = getCompatRuntimeLlamaCpp(config);
  const priorMessages = Array.isArray(session.messages) ? session.messages : [];
  const hiddenToolContexts = Array.isArray(session.hiddenToolContexts)
    ? (session.hiddenToolContexts as Dict[])
      .map((entry: Dict) => (entry && typeof entry.content === 'string' ? (entry.content as string).trim() : ''))
      .filter(Boolean)
    : [];
  const hiddenToolContextText = hiddenToolContexts.join('\n\n');
  const systemPrompt = typeof options.promptPrefix === 'string' && options.promptPrefix.trim()
    ? options.promptPrefix.trim()
    : 'general, coder friendly assistant';
  const systemContent = hiddenToolContextText
    ? `${systemPrompt}\n\nInternal tool-call context from prior session steps. Use this as additional evidence only when relevant.\n\n${hiddenToolContextText}`
    : systemPrompt;
  const messages = [
    { role: 'system', content: systemContent },
    ...priorMessages.map((message: Dict) => {
      const replayedMessage: Dict = {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
      };
      if (
        replayedMessage.role === 'assistant'
        && shouldReplayReasoningContent(config)
        && typeof message.thinkingContent === 'string'
        && message.thinkingContent.trim()
      ) {
        replayedMessage.reasoning_content = message.thinkingContent.trim();
      }
      return replayedMessage;
    }),
    { role: 'user', content: userContent },
  ];
  const thinkingEnabled = options.thinkingEnabled !== false;
  const body: Dict = {
    model,
    messages,
    stream: Boolean(options.stream),
    cache_prompt: true,
    ...(Number.isFinite(runtimeLlama?.Temperature) ? { temperature: Number(runtimeLlama.Temperature) } : {}),
    ...(Number.isFinite(runtimeLlama?.TopP) ? { top_p: Number(runtimeLlama.TopP) } : {}),
    ...(Number.isFinite(runtimeLlama?.MaxTokens) ? { max_tokens: Number(runtimeLlama.MaxTokens) } : {}),
    chat_template_kwargs: {
      enable_thinking: thinkingEnabled,
      ...(thinkingEnabled && shouldReplayReasoningContent(config) ? { reasoning_content: true } : {}),
      ...(shouldPreserveThinking(config, thinkingEnabled) ? { preserve_thinking: true } : {}),
    },
    extra_body: {
      ...(Number.isFinite(runtimeLlama?.TopK) ? { top_k: Number(runtimeLlama.TopK) } : {}),
      ...(Number.isFinite(runtimeLlama?.MinP) ? { min_p: Number(runtimeLlama.MinP) } : {}),
      ...(Number.isFinite(runtimeLlama?.PresencePenalty) ? { presence_penalty: Number(runtimeLlama.PresencePenalty) } : {}),
      ...(Number.isFinite(runtimeLlama?.RepetitionPenalty) ? { repeat_penalty: Number(runtimeLlama.RepetitionPenalty) } : {}),
      ...(thinkingEnabled ? {} : { reasoning_budget: 0 }),
    },
  };
  return {
    url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
    model,
    body,
  };
}

export type ChatUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
};

export async function generateChatAssistantMessage(
  config: Dict,
  session: ChatSession,
  userContent: string,
  options: { promptPrefix?: string } = {},
): Promise<{ assistantContent: string; thinkingContent: string; usage: ChatUsage }> {
  const request = buildChatCompletionRequest(config, session, userContent, {
    thinkingEnabled: session.thinkingEnabled !== false,
    stream: false,
    promptPrefix: options.promptPrefix,
  });
  const response = await requestJsonFull({
    url: request.url,
    method: 'POST',
    timeoutMs: 600000,
    body: JSON.stringify(request.body),
  });
  if (response.statusCode >= 400) {
    const detail = String(response.rawText || '').trim();
    throw new Error(`llama.cpp chat failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
  }
  const responseBody = response.body as Dict;
  const choice = Array.isArray(responseBody?.choices) ? (responseBody.choices[0] as Dict) : null;
  const assistantContent = getChoiceText(choice);
  const thinkingContent = getChoiceReasoningText(choice);
  if (!assistantContent) {
    throw new Error('llama.cpp chat returned an empty assistant message.');
  }
  const usage = responseBody?.usage && typeof responseBody.usage === 'object' ? responseBody.usage as Dict : {};
  return {
    assistantContent,
    thinkingContent,
    usage: {
      promptTokens: getChatUsageValue(usage.prompt_tokens),
      completionTokens: getChatUsageValue(usage.completion_tokens),
      thinkingTokens: getThinkingTokensFromUsage(usage),
      promptCacheTokens: getPromptCacheTokensFromUsage(usage),
      promptEvalTokens: getPromptEvalTokensFromUsage(usage),
    },
  };
}

type AppendChatOptions = {
  toolContextContents?: string[];
  requestDurationMs?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  requestStartedAtUtc?: string | null;
  thinkingStartedAtUtc?: string | null;
  thinkingEndedAtUtc?: string | null;
  answerStartedAtUtc?: string | null;
  answerEndedAtUtc?: string | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  sourceRunId?: string | null;
};

export function appendChatMessagesWithUsage(
  runtimeRoot: string,
  session: ChatSession,
  content: string,
  assistantContent: string,
  usage: Partial<ChatUsage> = {},
  thinkingContent: string = '',
  options: AppendChatOptions = {}
): ChatSession {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  const promptTokens = getChatUsageValue(usage.promptTokens);
  const promptCacheTokens = getChatUsageValue(usage.promptCacheTokens);
  const promptEvalTokens = getChatUsageValue(usage.promptEvalTokens);
  const completionTokens = getChatUsageValue(usage.completionTokens);
  const usageThinkingTokens = getChatUsageValue(usage.thinkingTokens);
  const processedPromptTokens = getProcessedPromptTokens(promptTokens, promptCacheTokens, promptEvalTokens);
  const userTokens = processedPromptTokens ?? estimateTokenCount(content);
  const explicitOutputTokens = getChatUsageValue(options.outputTokens);
  const explicitThinkingTokens = getChatUsageValue(options.thinkingTokens);
  const outputTokens = explicitOutputTokens ?? completionTokens ?? estimateTokenCount(assistantContent);
  const thinkingTokens = explicitThinkingTokens ?? usageThinkingTokens ?? 0;
  const toolContextContents = Array.isArray(options.toolContextContents)
    ? options.toolContextContents
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    : [];
  const hiddenToolContexts = Array.isArray(session.hiddenToolContexts) ? (session.hiddenToolContexts as Dict[]).slice() : [];
  messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    content,
    inputTokensEstimate: userTokens,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated: processedPromptTokens === null,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
    createdAtUtc: now,
    sourceRunId: null,
  });
  const assistantMessageId = crypto.randomUUID();
  const associatedToolTokens = toolContextContents.reduce((sum: number, value: string) => sum + estimateTokenCount(value), 0);
  messages.push({
    id: assistantMessageId,
    role: 'assistant',
    content: assistantContent,
    inputTokensEstimate: 0,
    outputTokensEstimate: outputTokens,
    thinkingTokens,
    inputTokensEstimated: false,
    outputTokensEstimated: completionTokens === null,
    thinkingTokensEstimated: usageThinkingTokens === null,
    promptCacheTokens,
    promptEvalTokens,
    requestDurationMs: Number.isFinite(Number(options.requestDurationMs)) ? Number(options.requestDurationMs) : null,
    promptEvalDurationMs: Number.isFinite(Number(options.promptEvalDurationMs)) ? Number(options.promptEvalDurationMs) : null,
    generationDurationMs: Number.isFinite(Number(options.generationDurationMs)) ? Number(options.generationDurationMs) : null,
    requestStartedAtUtc: typeof options.requestStartedAtUtc === 'string' && options.requestStartedAtUtc.trim() ? options.requestStartedAtUtc : null,
    thinkingStartedAtUtc: typeof options.thinkingStartedAtUtc === 'string' && options.thinkingStartedAtUtc.trim() ? options.thinkingStartedAtUtc : null,
    thinkingEndedAtUtc: typeof options.thinkingEndedAtUtc === 'string' && options.thinkingEndedAtUtc.trim() ? options.thinkingEndedAtUtc : null,
    answerStartedAtUtc: typeof options.answerStartedAtUtc === 'string' && options.answerStartedAtUtc.trim() ? options.answerStartedAtUtc : null,
    answerEndedAtUtc: typeof options.answerEndedAtUtc === 'string' && options.answerEndedAtUtc.trim() ? options.answerEndedAtUtc : null,
    speculativeAcceptedTokens: Number.isFinite(Number(options.speculativeAcceptedTokens)) ? Number(options.speculativeAcceptedTokens) : null,
    speculativeGeneratedTokens: Number.isFinite(Number(options.speculativeGeneratedTokens)) ? Number(options.speculativeGeneratedTokens) : null,
    associatedToolTokens,
    thinkingContent: String(thinkingContent || ''),
    createdAtUtc: now,
    sourceRunId: typeof options.sourceRunId === 'string' && options.sourceRunId.trim() ? options.sourceRunId : null,
  });
  for (const value of toolContextContents) {
    hiddenToolContexts.push({
      id: crypto.randomUUID(),
      content: value,
      tokenEstimate: estimateTokenCount(value),
      sourceMessageId: assistantMessageId,
      createdAtUtc: now,
    });
  }
  const updated: ChatSession = {
    ...session,
    updatedAtUtc: now,
    messages,
    hiddenToolContexts,
  };
  saveChatSession(runtimeRoot, updated);
  return updated;
}

export type StreamProgress = { assistantContent: string; thinkingContent: string };
type StreamResult = { assistantContent: string; thinkingContent: string; usage: ChatUsage };

export async function streamChatAssistantMessage(
  config: Dict,
  session: ChatSession,
  userContent: string,
  onProgress: ((progress: StreamProgress) => void) | null,
  options: { promptPrefix?: string } = {},
): Promise<StreamResult> {
  const requestConfig = buildChatCompletionRequest(config, session, userContent, {
    thinkingEnabled: session.thinkingEnabled !== false,
    stream: true,
    promptPrefix: options.promptPrefix,
  });
  const target = new URL(requestConfig.url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(requestConfig.body), 'utf8'),
      },
    }, (response) => {
      if ((response.statusCode || 0) >= 400) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          reject(new Error(`llama.cpp chat stream failed with HTTP ${response.statusCode || 0}${body.trim() ? `: ${body.trim()}` : '.'}`));
        });
        return;
      }
      let rawBuffer = '';
      let assistantContent = '';
      let thinkingContent = '';
      let finalUsage: ChatUsage = { promptTokens: null, completionTokens: null, thinkingTokens: null, promptCacheTokens: null, promptEvalTokens: null };
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        rawBuffer += chunk;
        let boundary = rawBuffer.indexOf('\n\n');
        while (boundary >= 0) {
          const packet = rawBuffer.slice(0, boundary);
          rawBuffer = rawBuffer.slice(boundary + 2);
          boundary = rawBuffer.indexOf('\n\n');
          const lines = packet
            .split(/\r?\n/gu)
            .map((line) => line.trim())
            .filter(Boolean);
          const dataLine = lines.find((line) => line.startsWith('data:'));
          if (!dataLine) {
            continue;
          }
          const dataValue = dataLine.slice(5).trim();
          if (dataValue === '[DONE]') {
            continue;
          }
          try {
            const parsed = JSON.parse(dataValue) as Dict;
            const choice = Array.isArray(parsed?.choices) ? (parsed.choices[0] as Dict) : null;
            const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta as Dict : {};
            const deltaThinking = getTextContent(delta.reasoning_content);
            const deltaAnswer = getTextContent(delta.content);
            if (deltaThinking) {
              thinkingContent += deltaThinking;
            }
            if (deltaAnswer) {
              assistantContent += deltaAnswer;
            }
            if (parsed?.usage && typeof parsed.usage === 'object') {
              const usage = parsed.usage as Dict;
              finalUsage = {
                promptTokens: getChatUsageValue(usage.prompt_tokens),
                completionTokens: getChatUsageValue(usage.completion_tokens),
                thinkingTokens: getThinkingTokensFromUsage(usage),
                promptCacheTokens: getPromptCacheTokensFromUsage(usage),
                promptEvalTokens: getPromptEvalTokensFromUsage(usage),
              };
            }
            if (typeof onProgress === 'function') {
              onProgress({
                assistantContent,
                thinkingContent,
              });
            }
          } catch {
            // Ignore malformed stream chunks.
          }
        }
      });
      response.on('end', () => {
        if (!assistantContent.trim()) {
          reject(new Error('llama.cpp chat stream returned an empty assistant message.'));
          return;
        }
        resolve({
          assistantContent: assistantContent.trim(),
          thinkingContent: thinkingContent.trim(),
          usage: finalUsage,
        });
      });
    });
    request.setTimeout(600000, () => {
      request.destroy(new Error('llama.cpp chat stream timed out.'));
    });
    request.on('error', reject);
    request.write(JSON.stringify(requestConfig.body));
    request.end();
  });
}

export function condenseChatSession(runtimeRoot: string, session: ChatSession): ChatSession {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  const keptCount = Math.min(messages.length, 2);
  const startIndex = Math.max(messages.length - keptCount, 0);
  const sourceMessages = startIndex > 0 ? messages.slice(0, startIndex) : messages;
  const condensedText = sourceMessages
    .map((message: Dict) => `${message.role}: ${String(message.content || '')}`)
    .join('\n');
  const condensedTail = condensedText.length > 2400 ? condensedText.slice(condensedText.length - 2400) : condensedText;
  const nextMessages = messages.map((message: Dict, index: number) => ({
    ...message,
    compressedIntoSummary: index < startIndex,
  }));
  const updated: ChatSession = {
    ...session,
    updatedAtUtc: now,
    condensedSummary: condensedTail || session.condensedSummary || '',
    messages: nextMessages,
  };
  saveChatSession(runtimeRoot, updated);
  return updated;
}

export function buildPlanRequestPrompt(userPrompt: unknown): string {
  const task = String(userPrompt || '').trim();
  return [
    'You are creating an implementation plan from repository evidence.',
    'Search thoroughly before finishing.',
    'Required output format (Markdown):',
    '1. Summary of Request and Approach',
    '2. Goal',
    '3. Current State (with explicit file paths)',
    '4. Implementation Plan (numbered steps covering what, where, how, and why)',
    '5. Code Evidence (each bullet must include file path + line numbers + a short code snippet)',
    '6. Critical Review (risks, flaws, better alternatives, edge cases, missing tests)',
    '7. Validation Plan (tests + checks)',
    '8. Open Questions (if any)',
    'Constraints:',
    '- Start with a short "Summary of Request and Approach" describing how you will tackle the request.',
    '- Review for any misalignment between the request and existing repository behavior/architecture; call it out explicitly.',
    '- If the request appears faulty, contradictory, or nonsensical, say so clearly and explain why.',
    '- Add clear open questions at the bottom when clarification is needed to refine the plan.',
    '- The plan should be comprehensive and usable as an implementation blueprint.',
    '- Be critical; call out any concerns clearly.',
    '- Use concrete line references like path/to/file.ts:123.',
    '- Include short code snippets for the referenced lines and explain the reasoning for proposed changes.',
    '- Prefer precise, executable steps over broad advice.',
    '',
    `Task: ${task}`,
  ].join('\n');
}

function truncatePlanEvidence(value: unknown, maxLength: number = 700): string {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

export function buildPlanMarkdownFromRepoSearch(userPrompt: string, repoRoot: string, result: Dict | null | undefined): string {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard as Dict : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks as Dict[] : [];
  const primaryTask = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
  const modelOutput = typeof primaryTask?.finalOutput === 'string' && (primaryTask.finalOutput as string).trim()
    ? (primaryTask.finalOutput as string).trim()
    : 'No final planner output was produced.';
  const commandEvidence: Array<{ command: string; output: string }> = [];
  for (let taskIndex = tasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
    const task = tasks[taskIndex];
    if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
      continue;
    }
    const commands = task.commands as Dict[];
    for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex -= 1) {
      const command = commands[commandIndex];
      if (!command || typeof command !== 'object') {
        continue;
      }
      const commandText = typeof command.command === 'string' ? (command.command as string).trim() : '';
      const outputText = truncatePlanEvidence(command.output);
      if (!commandText || !outputText) {
        continue;
      }
      commandEvidence.push({ command: commandText, output: outputText });
      if (commandEvidence.length >= 6) {
        break;
      }
    }
    if (commandEvidence.length >= 6) {
      break;
    }
  }
  const lines = [
    '# Implementation Plan',
    '',
    '## Request',
    userPrompt,
    '',
    '## Target Repo Root',
    `\`${repoRoot}\``,
    '',
    '## Planner Output',
    modelOutput,
    '',
    '## Code Evidence',
  ];
  if (commandEvidence.length === 0) {
    lines.push('- No command evidence was captured.');
  } else {
    for (const entry of commandEvidence) {
      lines.push(`- Command: \`${entry.command}\``);
      lines.push('```text');
      lines.push(entry.output);
      lines.push('```');
    }
  }
  lines.push('', '## Critical Review');
  const missingSignals = Array.isArray(primaryTask?.missingSignals) ? primaryTask.missingSignals as unknown[] : [];
  if (missingSignals.length > 0) {
    lines.push(`- Missing expected evidence signals: ${missingSignals.join(', ')}`);
  } else {
    lines.push('- Verify that proposed changes preserve existing behavior and test coverage.');
  }
  lines.push('- Check for hidden coupling between chat flow state, session persistence, and model-request locking.');
  lines.push('- Validate repo-root input carefully to avoid running searches outside intended workspace.');
  lines.push('', '## Artifacts');
  lines.push(`- Transcript: \`${String(result?.transcriptPath || '')}\``);
  lines.push(`- Artifact: \`${String(result?.artifactPath || '')}\``);
  return lines.join('\n');
}

export function getScorecardTotal(scorecard: unknown, key: string): number | null {
  if (!scorecard || typeof scorecard !== 'object') {
    return null;
  }
  const totals = (scorecard as Dict).totals;
  if (!totals || typeof totals !== 'object') {
    return null;
  }
  const value = (totals as Dict)[key];
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function truncateToolContextOutput(value: unknown, maxLength: number = 1400): string {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

export function buildToolContextFromRepoSearchResult(result: Dict | null | undefined): string[] {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard as Dict : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks as Dict[] : [];
  const contexts: string[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
      continue;
    }
    for (const command of task.commands as Dict[]) {
      if (!command || typeof command !== 'object') {
        continue;
      }
      const commandText = typeof command.command === 'string' ? (command.command as string).trim() : '';
      if (!commandText) {
        continue;
      }
      const outputText = truncateToolContextOutput(command.output);
      const exitCode = Number.isFinite(command.exitCode) ? Number(command.exitCode) : null;
      contexts.push([
        `Command: ${commandText}`,
        `Exit Code: ${exitCode === null ? 'n/a' : String(exitCode)}`,
        'Result:',
        outputText || '(empty output)',
      ].join('\n'));
    }
  }
  return contexts;
}

export function buildRepoSearchMarkdown(userPrompt: string, repoRoot: string, result: Dict | null | undefined): string {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard as Dict : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks as Dict[] : [];
  const primaryTask = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
  const modelOutput = typeof primaryTask?.finalOutput === 'string' && (primaryTask.finalOutput as string).trim()
    ? (primaryTask.finalOutput as string).trim()
    : 'No repo-search output was produced.';
  const lines = [
    '# Repo Search Results',
    '',
    '## Query',
    userPrompt,
    '',
    '## Repo Root',
    `\`${repoRoot}\``,
    '',
    '## Output',
    modelOutput,
    '',
    '## Artifacts',
  ];
  lines.push(`- Transcript: \`${String(result?.transcriptPath || '')}\``);
  lines.push(`- Artifact: \`${String(result?.artifactPath || '')}\``);
  return lines.join('\n');
}

export type RepoSearchExecuteFn = (request: Dict) => Promise<Dict>;

export function loadRepoSearchExecutor(): RepoSearchExecuteFn {
  const modulePath = require.resolve('../repo-search/index.js');
  delete require.cache[modulePath];
  const loadedModule = require(modulePath) as { executeRepoSearchRequest?: unknown };
  if (!loadedModule || typeof loadedModule.executeRepoSearchRequest !== 'function') {
    throw new Error('repo-search module does not export executeRepoSearchRequest.');
  }
  return loadedModule.executeRepoSearchRequest as RepoSearchExecuteFn;
}
