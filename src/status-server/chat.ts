import * as crypto from 'node:crypto';
import type { Dict } from '../lib/types.js';
import { LlamaClient } from '../lib/llama-client.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import { estimatePromptTokenCountFromCharacters, getDynamicMaxOutputTokens } from '../lib/dynamic-output-cap.js';
import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import {
  type ChatSession,
  estimateTokenCount,
  saveChatSession,
} from '../state/chat-sessions.js';
import {
  DEFAULT_LLAMA_MODEL,
  getLlamaBaseUrl,
  getRuntimeLlamaCpp,
} from './config-store.js';
import {
  getCompletionUsageFromResponseBody,
  getProcessedPromptTokens,
  getPromptUsageFromResponseBody,
  getTimingUsageFromResponseBody,
} from '../lib/provider-helpers.js';
import {
  getGenerationTokensPerSecond,
  getPromptTokensPerSecond,
} from '../lib/telemetry-metrics.js';
import { getDisplayToolCommand } from './tool-command-display.js';
import { ModelJson } from '../lib/model-json.js';
import { WebResearchTools } from '../web-search/web-research-tools.js';
import type { WebFetchToolArgs, WebSearchToolArgs } from '../web-search/types.js';

const DEFAULT_CHAT_SYSTEM_PROMPT = 'general, coder friendly assistant';

// Decision-turn system instruction (web-on). Drives tool selection; the model
// must emit exactly one tiny JSON action and must NOT write the answer here.
export const WEB_CHAT_DECISION_PROMPT = [
  'You have live web access via tools. Decide the single next step and respond with exactly one JSON object, no markdown, no prose:',
  'To search the web: {"action":"web_search","query":"...","timeFilter":"week"}',
  'To fetch a public URL: {"action":"web_fetch","url":"https://example.com/page"}',
  'To answer the user now: {"action":"answer"}',
  'Any value that can change over time MUST be verified with web_search before answering — for example: live or Grand Exchange / market item prices, currency and crypto exchange rates, stock quotes, breaking news and current events, weather, sports scores and standings, release dates, and the latest version of software or libraries.',
  'Anything about real-world events or any form of media — songs, videos, movies, TV shows, games, books, albums, and similar — MUST be verified with web_search rather than answered from training data or memory, because such details change over time and your memory may be outdated or wrong.',
  'Use stable, well-known static facts directly via {"action":"answer"} without searching.',
  'Private, local, and internal URLs are blocked.',
].join('\n');

// Final-answer-turn system instruction (web-on). Plain streamed prose answer.
export const WEB_CHAT_ANSWER_PROMPT = [
  'You have web access and may have already gathered web evidence (shown as prior tool results).',
  'Answer the user directly in normal prose/markdown. Base any fluctuating data (prices, rates, versions, news) on the gathered web evidence and cite source URLs where relevant.',
].join('\n');

// Steering nudge (web-on) injected transiently when the model tries to answer
// after searching without opening any result. Delivered only on the re-decision
// turn via a local evidence copy and never persisted, so it cannot pollute chat
// history.
export const WEB_CHAT_STEER_PROMPT = [
  'You ran a web_search but have not opened any result page yet.',
  'Do NOT answer from search-result snippets alone.',
  'Either read an actual page with {"action":"web_fetch","url":"<one of the returned result URLs>"},',
  'or run a different {"action":"web_search","query":"..."} if the results were poor.',
  'Only answer once you have read a page.',
].join('\n');

const WEB_CHAT_MAX_TOOL_CALLS = 4;
const WEB_CHAT_MAX_STEER_ATTEMPTS = 3;
const HIDDEN_TOOL_CONTEXT_PROMPT =
  'Internal tool-call context from prior session steps. Use this as additional evidence only when relevant.';

function getTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getMessageContextTokenEstimate(message: Dict): number {
  if (message.kind === 'assistant_thinking') {
    return estimateTokenCount(message.content);
  }
  return estimateTokenCount(formatChatMessageForPrompt(message)) + getMessageThinkingTokenEstimate(message);
}

function getMessageThinkingTokenEstimate(message: Dict): number {
  if (message.kind === 'assistant_thinking') {
    return estimateTokenCount(message.content);
  }
  return estimateTokenCount(getTrimmedString(message.thinkingContent));
}

function getHiddenToolContextTokenEstimate(entry: Dict): number {
  const tokenEstimate = Number(entry?.tokenEstimate);
  if (Number.isFinite(tokenEstimate) && tokenEstimate >= 0) {
    return Math.trunc(tokenEstimate);
  }
  return estimateTokenCount(entry?.content);
}

function formatChatMessageForPrompt(message: Dict): string {
  if (message.kind === 'assistant_tool_call') {
    const command = getTrimmedString(message.toolCallCommand) || getTrimmedString(message.content);
    const output = getTrimmedString(message.toolCallOutput) || getTrimmedString(message.toolCallOutputSnippet);
    if (command && output) {
      return `Tool call: ${command}\n\nResult:\n${output}`;
    }
    return command || output || getTrimmedString(message.content);
  }
  return String(message.content || '');
}

type ContextUsageTokenTotals = {
  contextWindowTokens: number;
  chatUsedTokens: number;
  thinkingUsedTokens: number;
  toolUsedTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
};

class ContextUsageBuilder {
  constructor(
    private readonly config: Dict | null | undefined,
    private readonly session: ChatSession,
  ) {}

  build(): Dict {
    const totals = this.buildTokenTotals();
    const warnThresholdTokens = Math.max(5000, Math.ceil(totals.contextWindowTokens * 0.1));
    return {
      contextWindowTokens: totals.contextWindowTokens,
      usedTokens: totals.chatUsedTokens,
      chatUsedTokens: totals.chatUsedTokens,
      thinkingUsedTokens: totals.thinkingUsedTokens,
      toolUsedTokens: totals.toolUsedTokens,
      totalUsedTokens: totals.totalUsedTokens,
      remainingTokens: totals.remainingTokens,
      warnThresholdTokens,
      shouldCondense: totals.remainingTokens <= warnThresholdTokens,
      estimatedTokenFallbackTokens: 0,
      providerOverheadTokens: this.getProviderOverheadTokens(),
    };
  }

  private buildTokenTotals(): ContextUsageTokenTotals {
    const contextWindowTokens = Math.max(1, Number(this.session.contextWindowTokens || 150000));
    const messages = Array.isArray(this.session.messages) ? this.session.messages : [];
    const messageTokens = messages.reduce((sum: number, message: Dict) => sum + getMessageContextTokenEstimate(message), 0);
    const thinkingUsedTokens = messages.reduce((sum: number, message: Dict) => sum + getMessageThinkingTokenEstimate(message), 0);
    const chatUsedTokens = estimateTokenCount(DEFAULT_CHAT_SYSTEM_PROMPT) + messageTokens;
    const hiddenToolContexts = Array.isArray(this.session.hiddenToolContexts) ? this.session.hiddenToolContexts : [];
    const toolUsedTokens = hiddenToolContexts.length > 0
      ? estimateTokenCount(HIDDEN_TOOL_CONTEXT_PROMPT)
        + hiddenToolContexts.reduce((sum: number, entry: Dict) => sum + getHiddenToolContextTokenEstimate(entry), 0)
      : 0;
    const totalUsedTokens = chatUsedTokens + toolUsedTokens;
    return {
      contextWindowTokens,
      chatUsedTokens,
      thinkingUsedTokens,
      toolUsedTokens,
      totalUsedTokens,
      remainingTokens: Math.max(contextWindowTokens - totalUsedTokens, 0),
    };
  }

  private getProviderOverheadTokens(): number {
    const thinkingEnabled = this.session.thinkingEnabled !== false;
    const reserveShape: Dict = {
      model: resolveActiveChatModel(this.config, this.session),
      stream: false,
      cache_prompt: true,
      max_tokens: 0,
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: '' },
      ],
      chat_template_kwargs: {
        enable_thinking: thinkingEnabled,
        ...(thinkingEnabled && shouldReplayReasoningContent(this.config || {}) ? { reasoning_content: true } : {}),
        ...(shouldPreserveThinking(this.config || {}, thinkingEnabled) ? { preserve_thinking: true } : {}),
      },
    };
    return estimateTokenCount(JSON.stringify(reserveShape));
  }
}

export function buildContextUsage(config: Dict | null | undefined, session: ChatSession): Dict {
  return new ContextUsageBuilder(config, session).build();
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

export type ChatCompletionRequest = { url: string; model: string; body: Dict };
type ChatEvidenceMessage = { role: 'user' | 'assistant'; content: string };
type BuildChatOptions = {
  thinkingEnabled?: boolean;
  reasoningContentEnabled?: boolean;
  preserveThinkingEnabled?: boolean;
  stream?: boolean;
  promptPrefix?: string;
  webActionInstruction?: string;
  evidenceMessages?: ChatEvidenceMessage[];
};

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
  const runtimeLlama = getRuntimeLlamaCpp(config);
  const priorMessages = Array.isArray(session.messages) ? session.messages : [];
  const systemContent = buildChatSystemContent(config, session, options);
  const messages = [
    { role: 'system', content: systemContent },
    ...priorMessages.map((message: Dict) => {
      const replayedMessage: Dict = {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: formatChatMessageForPrompt(message),
      };
      if (
        replayedMessage.role === 'assistant'
        && shouldReplayReasoningContent(config)
        && message.kind !== 'assistant_thinking'
        && typeof message.thinkingContent === 'string'
        && message.thinkingContent.trim()
      ) {
        replayedMessage.reasoning_content = message.thinkingContent.trim();
      }
      return replayedMessage;
    }),
    { role: 'user', content: userContent },
    ...(Array.isArray(options.evidenceMessages)
      ? options.evidenceMessages.map((message) => ({ role: message.role, content: message.content }))
      : []),
  ];
  const thinkingEnabled = options.thinkingEnabled !== false;
  const reasoningContentEnabled = options.reasoningContentEnabled
    ?? (thinkingEnabled && shouldReplayReasoningContent(config));
  const preserveThinkingEnabled = options.preserveThinkingEnabled
    ?? shouldPreserveThinking(config, thinkingEnabled);
  const promptCharacterCount = messages.reduce((total, message) => total + String(message.content || '').length, 0);
  const maxTokens = getDynamicMaxOutputTokens({
    totalContextTokens: Math.max(1, Number(session.contextWindowTokens || runtimeLlama?.NumCtx || 150000)),
    promptTokenCount: estimatePromptTokenCountFromCharacters(config, promptCharacterCount),
  });
  const body: Dict = {
    model,
    messages,
    stream: Boolean(options.stream),
    cache_prompt: true,
    max_tokens: maxTokens,
  };
  if (thinkingEnabled) {
    body.chat_template_kwargs = {
      enable_thinking: true,
      ...(reasoningContentEnabled ? { reasoning_content: true } : {}),
      ...(preserveThinkingEnabled ? { preserve_thinking: true } : {}),
    };
  }
  return {
    url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
    model,
    body,
  };
}

export function buildChatSystemContent(_config: Dict, session: ChatSession, options: Pick<BuildChatOptions, 'promptPrefix' | 'webActionInstruction'> = {}): string {
  const hiddenToolContexts = Array.isArray(session.hiddenToolContexts)
    ? (session.hiddenToolContexts as Dict[])
      .map((entry: Dict) => (entry && typeof entry.content === 'string' ? (entry.content as string).trim() : ''))
      .filter(Boolean)
    : [];
  const hiddenToolContextText = hiddenToolContexts.join('\n\n');
  const systemPrompt = typeof options.promptPrefix === 'string' && options.promptPrefix.trim()
    ? options.promptPrefix.trim()
    : DEFAULT_CHAT_SYSTEM_PROMPT;
  const baseContent = hiddenToolContextText
    ? `${systemPrompt}\n\n${HIDDEN_TOOL_CONTEXT_PROMPT}\n\n${hiddenToolContextText}`
    : systemPrompt;
  return typeof options.webActionInstruction === 'string' && options.webActionInstruction.trim()
    ? `${baseContent}\n\n${options.webActionInstruction.trim()}`
    : baseContent;
}

export type ChatUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
};

function buildWebToolBubble(
  command: string,
  output: string,
  outputTokens: number | null,
  turn: number,
  maxTurns: number,
  exitCode: number = 0,
): PersistToolMessage {
  return {
    id: crypto.randomUUID(),
    content: command,
    toolCallCommand: command,
    toolCallTurn: turn,
    toolCallMaxTurns: maxTurns,
    toolCallExitCode: exitCode,
    toolCallPromptTokenCount: null,
    toolCallOutputSnippet: output.length > 200 ? `${output.slice(0, 200)}...` : output,
    toolCallOutput: output,
    outputTokens,
  };
}

const EMPTY_CHAT_USAGE: ChatUsage = {
  promptTokens: null,
  completionTokens: null,
  thinkingTokens: null,
  promptCacheTokens: null,
  promptEvalTokens: null,
};

export type PersistToolMessage = {
  id: string;
  content: string;
  toolCallCommand: string;
  toolCallTurn: number;
  toolCallMaxTurns: number;
  toolCallExitCode: number | null;
  toolCallPromptTokenCount?: number | null;
  toolCallOutputSnippet: string;
  toolCallOutput: string;
  outputTokens: number | null;
};
export type PersistTurn = { thinkingText: string; toolMessages: PersistToolMessage[] };

type AppendChatOptions = {
  turns: PersistTurn[];
  toolContextContents?: string[];
  requestDurationMs?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
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
  options: AppendChatOptions = { turns: [] }
): ChatSession {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  const promptTokens = getChatUsageValue(usage.promptTokens);
  const promptCacheTokens = getChatUsageValue(usage.promptCacheTokens);
  const promptEvalTokens = getChatUsageValue(usage.promptEvalTokens);
  const completionTokens = getChatUsageValue(usage.completionTokens);
  const usageThinkingTokens = getChatUsageValue(usage.thinkingTokens);
  const usagePromptEvalDurationMs = getChatUsageValue(usage.promptEvalDurationMs);
  const usageGenerationDurationMs = getChatUsageValue(usage.generationDurationMs);
  const usagePromptTokensPerSecond = getChatUsageValue(usage.promptTokensPerSecond);
  const usageGenerationTokensPerSecond = getChatUsageValue(usage.generationTokensPerSecond);
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
  const sourceRunId = typeof options.sourceRunId === 'string' && options.sourceRunId.trim() ? options.sourceRunId : null;
  messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    kind: 'user_text',
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
  const turns = Array.isArray(options.turns) ? options.turns : [];
  const persistedToolMessageIds: string[] = [];
  for (const turn of turns) {
    const thinkingText = String(turn.thinkingText || '');
    if (thinkingText.trim()) {
      messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'assistant_thinking',
        content: thinkingText,
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: estimateTokenCount(thinkingText),
        inputTokensEstimated: false,
        outputTokensEstimated: false,
        thinkingTokensEstimated: usageThinkingTokens === null,
        createdAtUtc: now,
        sourceRunId,
      });
    }
    const turnToolMessages = Array.isArray(turn.toolMessages) ? turn.toolMessages : [];
    for (const toolMessage of turnToolMessages) {
      const toolMessageId = typeof toolMessage.id === 'string' && toolMessage.id.trim() ? toolMessage.id : crypto.randomUUID();
      const toolOutput = typeof toolMessage.toolCallOutput === 'string'
        ? toolMessage.toolCallOutput
        : typeof toolMessage.toolCallOutputSnippet === 'string'
          ? toolMessage.toolCallOutputSnippet
          : '';
      const explicitToolOutputTokens = getChatUsageValue(toolMessage.outputTokens);
      const toolOutputTokens = explicitToolOutputTokens ?? estimateTokenCount(toolOutput);
      messages.push({
        id: toolMessageId,
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: typeof toolMessage.content === 'string' ? toolMessage.content : String(toolMessage.toolCallCommand || ''),
        inputTokensEstimate: 0,
        outputTokensEstimate: toolOutputTokens,
        thinkingTokens: 0,
        inputTokensEstimated: false,
        outputTokensEstimated: explicitToolOutputTokens === null,
        thinkingTokensEstimated: false,
        promptEvalTokens: Number.isFinite(Number(toolMessage.toolCallPromptTokenCount)) ? Number(toolMessage.toolCallPromptTokenCount) : null,
        associatedToolTokens: toolOutputTokens,
        toolCallCommand: typeof toolMessage.toolCallCommand === 'string' ? toolMessage.toolCallCommand : String(toolMessage.content || ''),
        toolCallTurn: Number.isFinite(Number(toolMessage.toolCallTurn)) ? Number(toolMessage.toolCallTurn) : null,
        toolCallMaxTurns: Number.isFinite(Number(toolMessage.toolCallMaxTurns)) ? Number(toolMessage.toolCallMaxTurns) : null,
        toolCallExitCode: Number.isFinite(Number(toolMessage.toolCallExitCode)) ? Number(toolMessage.toolCallExitCode) : null,
        toolCallPromptTokenCount: Number.isFinite(Number(toolMessage.toolCallPromptTokenCount)) ? Number(toolMessage.toolCallPromptTokenCount) : null,
        toolCallOutputSnippet: typeof toolMessage.toolCallOutputSnippet === 'string' ? toolMessage.toolCallOutputSnippet : '',
        toolCallOutput: toolOutput,
        createdAtUtc: now,
        sourceRunId,
      });
      persistedToolMessageIds.push(toolMessageId);
    }
  }
  const assistantMessageId = crypto.randomUUID();
  const associatedToolTokens = toolContextContents.reduce((sum: number, value: string) => sum + estimateTokenCount(value), 0);
  messages.push({
    id: assistantMessageId,
    role: 'assistant',
    kind: 'assistant_answer',
    content: assistantContent,
    inputTokensEstimate: 0,
    outputTokensEstimate: outputTokens,
    thinkingTokens,
    inputTokensEstimated: false,
    outputTokensEstimated: completionTokens === null,
    thinkingTokensEstimated: usageThinkingTokens === null,
    promptCacheTokens,
    promptEvalTokens,
    promptTokensPerSecond: Number.isFinite(Number(options.promptTokensPerSecond))
      ? Number(options.promptTokensPerSecond)
      : usagePromptTokensPerSecond,
    generationTokensPerSecond: Number.isFinite(Number(options.generationTokensPerSecond))
      ? Number(options.generationTokensPerSecond)
      : usageGenerationTokensPerSecond,
    requestDurationMs: Number.isFinite(Number(options.requestDurationMs)) ? Number(options.requestDurationMs) : null,
    promptEvalDurationMs: Number.isFinite(Number(options.promptEvalDurationMs))
      ? Number(options.promptEvalDurationMs)
      : usagePromptEvalDurationMs,
    generationDurationMs: Number.isFinite(Number(options.generationDurationMs))
      ? Number(options.generationDurationMs)
      : usageGenerationDurationMs,
    requestStartedAtUtc: typeof options.requestStartedAtUtc === 'string' && options.requestStartedAtUtc.trim() ? options.requestStartedAtUtc : null,
    thinkingStartedAtUtc: typeof options.thinkingStartedAtUtc === 'string' && options.thinkingStartedAtUtc.trim() ? options.thinkingStartedAtUtc : null,
    thinkingEndedAtUtc: typeof options.thinkingEndedAtUtc === 'string' && options.thinkingEndedAtUtc.trim() ? options.thinkingEndedAtUtc : null,
    answerStartedAtUtc: typeof options.answerStartedAtUtc === 'string' && options.answerStartedAtUtc.trim() ? options.answerStartedAtUtc : null,
    answerEndedAtUtc: typeof options.answerEndedAtUtc === 'string' && options.answerEndedAtUtc.trim() ? options.answerEndedAtUtc : null,
    speculativeAcceptedTokens: Number.isFinite(Number(options.speculativeAcceptedTokens)) ? Number(options.speculativeAcceptedTokens) : null,
    speculativeGeneratedTokens: Number.isFinite(Number(options.speculativeGeneratedTokens)) ? Number(options.speculativeGeneratedTokens) : null,
    associatedToolTokens,
    thinkingContent: '',
    createdAtUtc: now,
    sourceRunId,
  });
  for (let index = 0; index < toolContextContents.length; index += 1) {
    const sourceMessageId = persistedToolMessageIds[index] || assistantMessageId;
    hiddenToolContexts.push({
      id: crypto.randomUUID(),
      content: toolContextContents[index],
      tokenEstimate: estimateTokenCount(toolContextContents[index]),
      sourceMessageId,
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
  options: {
    promptPrefix?: string;
    webActionInstruction?: string;
    evidenceMessages?: ChatEvidenceMessage[];
    thinkingEnabled?: boolean;
    reasoningContentEnabled?: boolean;
    preserveThinkingEnabled?: boolean;
  } = {},
): Promise<StreamResult> {
  const requestConfig = buildChatCompletionRequest(config, session, userContent, {
    thinkingEnabled: options.thinkingEnabled ?? (session.thinkingEnabled !== false),
    reasoningContentEnabled: options.reasoningContentEnabled,
    preserveThinkingEnabled: options.preserveThinkingEnabled,
    stream: true,
    promptPrefix: options.promptPrefix,
    webActionInstruction: options.webActionInstruction,
    evidenceMessages: options.evidenceMessages,
  });
  let assistantContent = '';
  let thinkingContent = '';
  let finalUsage: ChatUsage = {
    promptTokens: null,
    completionTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
  };
  await LlamaClient.streamChatCompletion({
    url: requestConfig.url,
    body: JSON.stringify(requestConfig.body),
    timeoutMs: 600000,
  }, (parsed) => {
    const choice = Array.isArray(parsed.choices) ? (parsed.choices[0] as Dict) : null;
    const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta as Dict : {};
    const deltaThinking = getTextContent(delta.reasoning_content);
    const deltaAnswer = getTextContent(delta.content);
    if (deltaThinking) {
      thinkingContent += deltaThinking;
    }
    if (deltaAnswer) {
      assistantContent += deltaAnswer;
    }
    const promptUsage = getPromptUsageFromResponseBody(parsed);
    const completionUsage = getCompletionUsageFromResponseBody(parsed);
    const timingUsage = getTimingUsageFromResponseBody(parsed);
    finalUsage = {
      promptTokens: promptUsage.promptTokens ?? finalUsage.promptTokens ?? null,
      completionTokens: completionUsage.completionTokens ?? finalUsage.completionTokens ?? null,
      thinkingTokens: completionUsage.thinkingTokens ?? finalUsage.thinkingTokens ?? null,
      promptCacheTokens: promptUsage.promptCacheTokens ?? finalUsage.promptCacheTokens ?? null,
      promptEvalTokens: promptUsage.promptEvalTokens ?? finalUsage.promptEvalTokens ?? null,
      promptEvalDurationMs: timingUsage.promptEvalDurationMs ?? finalUsage.promptEvalDurationMs ?? null,
      generationDurationMs: timingUsage.generationDurationMs ?? finalUsage.generationDurationMs ?? null,
      promptTokensPerSecond: getPromptTokensPerSecond(
        promptUsage.promptEvalTokens ?? finalUsage.promptEvalTokens ?? null,
        timingUsage.promptEvalDurationMs ?? finalUsage.promptEvalDurationMs ?? null,
      ),
      generationTokensPerSecond: getGenerationTokensPerSecond(
        completionUsage.completionTokens ?? finalUsage.completionTokens ?? null,
        completionUsage.thinkingTokens ?? finalUsage.thinkingTokens ?? null,
        timingUsage.generationDurationMs ?? finalUsage.generationDurationMs ?? null,
      ),
    };
    if (typeof onProgress === 'function') {
      onProgress({ assistantContent, thinkingContent });
    }
  });
  if (!assistantContent.trim()) {
    throw new Error('llama.cpp chat stream returned an empty assistant message.');
  }
  return {
    assistantContent: assistantContent.trim(),
    thinkingContent: thinkingContent.trim(),
    usage: finalUsage,
  };
}

// ---------------------------------------------------------------------------
// Streamed web direct-chat orchestrator
// ---------------------------------------------------------------------------

export type WebStreamPhase = 'decision' | 'answer';

export type WebStreamProgress =
  | { kind: 'thinking'; phase: WebStreamPhase; thinking: string }
  | { kind: 'answer'; answer: string }
  | { kind: 'tool_start'; toolCallId: string; turn: number; maxTurns: number; command: string }
  | { kind: 'tool_result'; toolCallId: string; turn: number; maxTurns: number; command: string; outputSnippet: string; outputTokens: number | null; exitCode: number };

export type WebStreamResult = { assistantContent: string; turns: PersistTurn[]; usage: ChatUsage };

type WebChatDecision =
  | { kind: 'web_search'; args: WebSearchToolArgs }
  | { kind: 'web_fetch'; args: WebFetchToolArgs }
  | { kind: 'answer' };

/**
 * Parses a decision-turn output into the next step. Any non-tool, malformed, or
 * unparseable output resolves to `answer` so a prose reply is never lost to a
 * JSON parse failure.
 */
function parseWebChatDecision(text: string): WebChatDecision {
  let action;
  try {
    action = ModelJson.parseRepoSearchPlannerAction(text, { allowedToolNames: ['web_search', 'web_fetch'] });
  } catch {
    return { kind: 'answer' };
  }
  if (action.action === 'tool' && action.tool_name === 'web_search') {
    return { kind: 'web_search', args: action.args as WebSearchToolArgs };
  }
  if (action.action === 'tool' && action.tool_name === 'web_fetch') {
    return { kind: 'web_fetch', args: action.args as WebFetchToolArgs };
  }
  return { kind: 'answer' };
}

function addNullableNumber(a: number | null | undefined, b: number | null | undefined): number | null {
  if ((a === null || a === undefined) && (b === null || b === undefined)) {
    return null;
  }
  return (a ?? 0) + (b ?? 0);
}

function mergeChatUsage(base: ChatUsage, next: ChatUsage): ChatUsage {
  return {
    promptTokens: next.promptTokens ?? base.promptTokens,
    completionTokens: addNullableNumber(base.completionTokens, next.completionTokens),
    thinkingTokens: addNullableNumber(base.thinkingTokens, next.thinkingTokens),
    promptCacheTokens: next.promptCacheTokens ?? base.promptCacheTokens,
    promptEvalTokens: addNullableNumber(base.promptEvalTokens, next.promptEvalTokens),
    promptEvalDurationMs: addNullableNumber(base.promptEvalDurationMs, next.promptEvalDurationMs),
    generationDurationMs: addNullableNumber(base.generationDurationMs, next.generationDurationMs),
    promptTokensPerSecond: next.promptTokensPerSecond ?? base.promptTokensPerSecond,
    generationTokensPerSecond: next.generationTokensPerSecond ?? base.generationTokensPerSecond,
  };
}

function mergePromptPrefix(prefix: string | undefined, suffix: string): string {
  return prefix && prefix.trim() ? `${prefix.trim()}\n\n${suffix}` : suffix;
}

function buildWebToolCommand(decision: { kind: 'web_search'; args: WebSearchToolArgs } | { kind: 'web_fetch'; args: WebFetchToolArgs }): string {
  if (decision.kind === 'web_search') {
    return `web_search query=${JSON.stringify(String(decision.args.query || '').trim())}`;
  }
  return `web_fetch url=${JSON.stringify(String(decision.args.url || '').trim())}`;
}

/**
 * Fully-streamed web direct-chat turn. Splits orchestration from answering:
 * each iteration runs a decision turn (streams thinking, buffers a tiny JSON
 * action), executes web tools emitting tool bubbles, then a final answer turn
 * streams plain prose. Web tools and the answer are never JSON-wrapped, so a
 * prose answer can never be lost to a parse failure. Runs only when the
 * effective web gate is enabled.
 */
export async function streamDirectChatWebTurn(
  config: Dict,
  session: ChatSession,
  userContent: string,
  webTools: WebResearchTools,
  onProgress: (progress: WebStreamProgress) => void,
  options: { promptPrefix?: string; maxTurns?: number; mockResponses?: string[] } = {},
): Promise<WebStreamResult> {
  const maxTurns = Number.isFinite(Number(options.maxTurns)) && Number(options.maxTurns) > 0
    ? Number(options.maxTurns)
    : WEB_CHAT_MAX_TOOL_CALLS;
  const mockResponses = Array.isArray(options.mockResponses) ? options.mockResponses.slice() : null;
  const evidenceMessages: ChatEvidenceMessage[] = [];
  const turns: PersistTurn[] = [];
  let aggregatedUsage: ChatUsage = EMPTY_CHAT_USAGE;
  let toolCalls = 0;
  let searchCount = 0;
  let fetchSucceeded = false;
  let blockedAnswers = 0;
  let steerMessage: string | null = null;
  const exposeThinking = session.thinkingEnabled !== false;

  const nextMock = (): string => {
    const value = mockResponses?.shift();
    if (value === undefined) {
      throw new Error('streamDirectChatWebTurn: ran out of mock responses.');
    }
    return value;
  };

  for (;;) {
    let decisionText: string;
    let decisionThinking = '';
    if (mockResponses) {
      decisionText = nextMock();
    } else {
      const decisionEvidence = steerMessage
        ? [...evidenceMessages, { role: 'user' as const, content: steerMessage }]
        : evidenceMessages.slice();
      const decision = await streamChatAssistantMessage(config, session, userContent, (progress) => {
        if (exposeThinking) {
          onProgress({ kind: 'thinking', phase: 'decision', thinking: progress.thinkingContent });
        }
      }, {
        promptPrefix: options.promptPrefix,
        webActionInstruction: WEB_CHAT_DECISION_PROMPT,
        evidenceMessages: decisionEvidence,
      });
      decisionText = decision.assistantContent;
      decisionThinking = decision.thinkingContent || '';
      aggregatedUsage = mergeChatUsage(aggregatedUsage, decision.usage);
    }

    const decision = parseWebChatDecision(decisionText);
    if (decision.kind !== 'answer' && toolCalls < maxTurns) {
      const toolCallId = crypto.randomUUID();
      const turnIndex = toolCalls + 1;
      const command = buildWebToolCommand(decision);
      if (decision.kind === 'web_search') {
        searchCount += 1;
      }
      steerMessage = null;
      onProgress({ kind: 'tool_start', toolCallId, turn: turnIndex, maxTurns, command });
      let bubble: PersistToolMessage;
      try {
        const toolResult = decision.kind === 'web_search'
          ? await webTools.search(decision.args)
          : await webTools.fetch(decision.args);
        bubble = buildWebToolBubble(toolResult.command, toolResult.output, toolResult.outputTokens, turnIndex, maxTurns, 0);
        onProgress({ kind: 'tool_result', toolCallId, turn: turnIndex, maxTurns, command: toolResult.command, outputSnippet: bubble.toolCallOutputSnippet, outputTokens: toolResult.outputTokens, exitCode: 0 });
        evidenceMessages.push({ role: 'assistant', content: decisionText });
        evidenceMessages.push({ role: 'user', content: `Tool ${toolResult.command} output:\n${toolResult.output}` });
        if (decision.kind === 'web_fetch') {
          fetchSucceeded = true;
        }
      } catch (error) {
        const failOutput = `web tool failed: ${error instanceof Error ? error.message : String(error)}`;
        const failTokens = estimateTokenCount(failOutput);
        bubble = buildWebToolBubble(command, failOutput, failTokens, turnIndex, maxTurns, 1);
        onProgress({ kind: 'tool_result', toolCallId, turn: turnIndex, maxTurns, command, outputSnippet: bubble.toolCallOutputSnippet, outputTokens: failTokens, exitCode: 1 });
        evidenceMessages.push({ role: 'assistant', content: decisionText });
        evidenceMessages.push({ role: 'user', content: `Tool ${command} ${failOutput}` });
      }
      turns.push({ thinkingText: exposeThinking ? decisionThinking : '', toolMessages: [bubble] });
      toolCalls += 1;
      continue;
    }

    const gateApplies = decision.kind === 'answer'
      && searchCount > 0
      && !fetchSucceeded
      && blockedAnswers < WEB_CHAT_MAX_STEER_ATTEMPTS
      && toolCalls < maxTurns;
    if (gateApplies) {
      blockedAnswers += 1;
      steerMessage = WEB_CHAT_STEER_PROMPT;
      continue;
    }
    steerMessage = null;

    if (exposeThinking && decisionThinking.trim()) {
      turns.push({ thinkingText: decisionThinking, toolMessages: [] });
    }
    let answerText: string;
    let answerThinking = '';
    if (mockResponses) {
      answerText = nextMock();
      onProgress({ kind: 'answer', answer: answerText });
    } else {
      const answer = await streamChatAssistantMessage(config, session, userContent, (progress) => {
        if (exposeThinking) {
          onProgress({ kind: 'thinking', phase: 'answer', thinking: progress.thinkingContent });
        }
        onProgress({ kind: 'answer', answer: progress.assistantContent });
      }, {
        promptPrefix: mergePromptPrefix(options.promptPrefix, WEB_CHAT_ANSWER_PROMPT),
        evidenceMessages: evidenceMessages.slice(),
      });
      answerText = answer.assistantContent;
      answerThinking = answer.thinkingContent || '';
      aggregatedUsage = mergeChatUsage(aggregatedUsage, answer.usage);
    }
    turns.push({ thinkingText: exposeThinking ? answerThinking : '', toolMessages: [] });
    return { assistantContent: answerText, turns, usage: aggregatedUsage };
  }
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
    ? RepoSearchOutputFormatter.collapseRepeatedWholeOutput(primaryTask.finalOutput as string)
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
      const commandText = getDisplayToolCommand(command);
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

function buildToolMessageFromCommand(command: Dict, turnsUsed: number): PersistToolMessage | null {
  if (!command || typeof command !== 'object') {
    return null;
  }
  const commandText = getDisplayToolCommand(command);
  if (!commandText) {
    return null;
  }
  const turn = Number(command.turn);
  if (!Number.isInteger(turn) || turn < 1) {
    // No legacy fallback: a persisted command must carry its real planner turn.
    throw new Error(`TaskCommand for "${commandText}" has an invalid turn: ${String(command.turn)}`);
  }
  const output = typeof command.promptOutput === 'string'
    ? command.promptOutput
    : typeof command.output === 'string'
      ? command.output
      : '';
  return {
    id: crypto.randomUUID(),
    content: commandText,
    toolCallCommand: commandText,
    toolCallTurn: turn,
    toolCallMaxTurns: turnsUsed,
    toolCallExitCode: Number.isFinite(Number(command.exitCode)) ? Number(command.exitCode) : null,
    toolCallPromptTokenCount: null,
    toolCallOutputSnippet: output.length > 200 ? `${output.slice(0, 200)}...` : output,
    toolCallOutput: output,
    outputTokens: getChatUsageValue(command.outputTokens),
  };
}

export function buildPersistTurnsFromRepoSearchResult(result: Dict | null | undefined): PersistTurn[] {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard as Dict : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks as Dict[] : [];
  const turns: PersistTurn[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      continue;
    }
    const commands = Array.isArray(task.commands) ? task.commands as Dict[] : [];
    // Resolve a sane "of Y" for tool bubbles. turnsUsed must be a positive integer
    // no smaller than the largest command turn; otherwise fall back to that max
    // (never the raw command count, and never a value that would render "3 of 2").
    const commandTurns = commands
      .map((command) => Number((command as Dict).turn))
      .filter((turn) => Number.isInteger(turn) && turn >= 1);
    const maxCommandTurn = commandTurns.length ? Math.max(...commandTurns) : 0;
    const rawTurnsUsed = Number(task.turnsUsed);
    const turnsUsed = Number.isInteger(rawTurnsUsed) && rawTurnsUsed >= maxCommandTurn
      ? rawTurnsUsed
      : maxCommandTurn;
    const turnThinking = task.turnThinking && typeof task.turnThinking === 'object'
      ? task.turnThinking as Dict
      : {};
    const toolsByTurn = new Map<number, PersistToolMessage[]>();
    for (const command of commands) {
      const message = buildToolMessageFromCommand(command, turnsUsed);
      if (!message) {
        continue;
      }
      const bucket = toolsByTurn.get(message.toolCallTurn);
      if (bucket) {
        bucket.push(message);
      } else {
        toolsByTurn.set(message.toolCallTurn, [message]);
      }
    }
    const thinkingTurns = Object.keys(turnThinking)
      .map((key) => Number(key))
      .filter((turn) => Number.isFinite(turn));
    const orderedTurns = [...new Set([...toolsByTurn.keys(), ...thinkingTurns])].sort((a, b) => a - b);
    for (const turn of orderedTurns) {
      const thinkingText = String(turnThinking[String(turn)] || '').trim();
      const toolMessages = toolsByTurn.get(turn) || [];
      if (!thinkingText && toolMessages.length === 0) {
        continue;
      }
      turns.push({ thinkingText, toolMessages });
    }
  }
  return turns;
}

export function buildRepoSearchMarkdown(userPrompt: string, repoRoot: string, result: Dict | null | undefined): string {
  const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard as Dict : {};
  const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks as Dict[] : [];
  const primaryTask = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
  const modelOutput = typeof primaryTask?.finalOutput === 'string' && (primaryTask.finalOutput as string).trim()
    ? RepoSearchOutputFormatter.collapseRepeatedWholeOutput(primaryTask.finalOutput as string)
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

export type RepoSearchExecuteFn = (request: Dict) => Promise<RepoSearchExecutionResult>;

export function loadRepoSearchExecutor(): RepoSearchExecuteFn {
  const modulePath = require.resolve('../repo-search/index.js');
  delete require.cache[modulePath];
  const loadedModule = require(modulePath) as { executeRepoSearchRequest?: unknown };
  if (!loadedModule || typeof loadedModule.executeRepoSearchRequest !== 'function') {
    throw new Error('repo-search module does not export executeRepoSearchRequest.');
  }
  return loadedModule.executeRepoSearchRequest as RepoSearchExecuteFn;
}
