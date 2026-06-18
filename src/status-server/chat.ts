import * as crypto from 'node:crypto';
import type { ServerManagedLlamaPreset, SiftConfig } from '../config/types.js';
import type { ChatMessage as PlannerChatMessage } from '../repo-search/planner-protocol.js';
import type { ChatGroundingStatus } from '../repo-search/chat-grounding-policy.js';
import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import { ThinkingRetentionPolicy } from '../thinking-retention-policy.js';
import { buildReplayToolCall } from '../llm-protocol/tool-call-parser.js';
import {
  type ChatSession,
  type ChatMessage as PersistedChatMessage,
  estimateTokenCount,
  saveChatSession,
} from '../state/chat-sessions.js';
import { DEFAULT_LLAMA_MODEL } from './config-store.js';
import {
  parseWebToolCommand,
  type RetainedWebToolCall,
} from '../web-search/web-tool-command.js';
import {
  normalizeRepoSearchResult,
  normalizeRepoSearchScorecard,
  type RepoSearchCommandResult,
  type RepoSearchScorecard,
} from './repo-search-scorecard-types.js';

const DEFAULT_CHAT_SYSTEM_PROMPT = 'general, coder friendly assistant';

function trimText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nonNegativeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function getMessageContextTokenEstimate(message: PersistedChatMessage): number {
  if (message.kind === 'assistant_thinking') {
    return estimateTokenCount(message.content);
  }
  return estimateTokenCount(formatChatMessageForPrompt(message)) + getMessageThinkingTokenEstimate(message);
}

function getMessageThinkingTokenEstimate(message: PersistedChatMessage): number {
  if (message.kind === 'assistant_thinking') {
    return estimateTokenCount(message.content);
  }
  return estimateTokenCount(trimText(message.thinkingContent));
}

function formatChatMessageForPrompt(message: PersistedChatMessage): string {
  if (message.kind === 'assistant_tool_call') {
    const command = trimText(message.toolCallCommand) || trimText(message.content);
    return command || trimText(message.content);
  }
  return String(message.content || '');
}

function getMessageToolTokenEstimate(message: PersistedChatMessage): number {
  if (message.kind !== 'assistant_tool_call') {
    return 0;
  }
  const outputTokens = nonNegativeNumber(message.outputTokensEstimate);
  const associatedToolTokens = nonNegativeNumber(message.associatedToolTokens);
  const explicitTokens = Math.max(outputTokens ?? 0, associatedToolTokens ?? 0);
  if (explicitTokens > 0 || outputTokens !== null || associatedToolTokens !== null) {
    return explicitTokens;
  }
  const output = trimText(message.toolCallOutput) || trimText(message.toolCallOutputSnippet);
  return output ? estimateTokenCount(output) : 0;
}

function getMessageToolTokenFallbackEstimate(message: PersistedChatMessage): number {
  if (message.kind !== 'assistant_tool_call') {
    return 0;
  }
  return message.outputTokensEstimated === false ? 0 : getMessageToolTokenEstimate(message);
}

type ContextUsageTokenTotals = {
  contextWindowTokens: number;
  chatUsedTokens: number;
  thinkingUsedTokens: number;
  toolUsedTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
  estimatedTokenFallbackTokens: number;
};

export type ContextUsage = {
  contextWindowTokens: number;
  usedTokens: number;
  chatUsedTokens: number;
  thinkingUsedTokens: number;
  toolUsedTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
  warnThresholdTokens: number;
  shouldCondense: boolean;
  estimatedTokenFallbackTokens: number;
  providerOverheadTokens: number;
};

class ContextUsageBuilder {
  constructor(
    private readonly config: SiftConfig | null | undefined,
    private readonly session: ChatSession,
  ) {}

  build(): ContextUsage {
    const totals = this.buildTokenTotals();
    const warnThresholdTokens = Math.max(5000, Math.ceil(totals.contextWindowTokens * 0.1));
    return {
      contextWindowTokens: totals.contextWindowTokens,
      usedTokens: totals.totalUsedTokens,
      chatUsedTokens: totals.chatUsedTokens,
      thinkingUsedTokens: totals.thinkingUsedTokens,
      toolUsedTokens: totals.toolUsedTokens,
      totalUsedTokens: totals.totalUsedTokens,
      remainingTokens: totals.remainingTokens,
      warnThresholdTokens,
      shouldCondense: totals.remainingTokens <= warnThresholdTokens,
      estimatedTokenFallbackTokens: totals.estimatedTokenFallbackTokens,
      providerOverheadTokens: this.getProviderOverheadTokens(),
    };
  }

  private buildTokenTotals(): ContextUsageTokenTotals {
    const contextWindowTokens = Math.max(1, Number(this.session.contextWindowTokens || 150000));
    const messages = Array.isArray(this.session.messages) ? this.session.messages : [];
    const messageTokens = messages.reduce((sum: number, message: PersistedChatMessage) => sum + getMessageContextTokenEstimate(message), 0);
    const thinkingUsedTokens = messages.reduce((sum: number, message: PersistedChatMessage) => sum + getMessageThinkingTokenEstimate(message), 0);
    const toolUsedTokens = messages.reduce((sum: number, message: PersistedChatMessage) => sum + getMessageToolTokenEstimate(message), 0);
    const chatUsedTokens = estimateTokenCount(DEFAULT_CHAT_SYSTEM_PROMPT) + messageTokens;
    const totalUsedTokens = chatUsedTokens + toolUsedTokens;
    const estimatedToolTokens = messages.reduce((sum: number, message: PersistedChatMessage) => sum + getMessageToolTokenFallbackEstimate(message), 0);
    return {
      contextWindowTokens,
      chatUsedTokens,
      thinkingUsedTokens,
      toolUsedTokens,
      totalUsedTokens,
      remainingTokens: Math.max(contextWindowTokens - totalUsedTokens, 0),
      estimatedTokenFallbackTokens: chatUsedTokens + estimatedToolTokens,
    };
  }

  private getProviderOverheadTokens(): number {
    const thinkingEnabled = this.session.thinkingEnabled !== false;
    const config = this.config;
    const reserveShape = {
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
        ...(config && thinkingEnabled && shouldReplayReasoningContent(config) ? { reasoning_content: true } : {}),
        ...(config && shouldPreserveThinking(config, thinkingEnabled) ? { preserve_thinking: true } : {}),
      },
    };
    return estimateTokenCount(JSON.stringify(reserveShape));
  }
}

export function buildContextUsage(config: SiftConfig | null | undefined, session: ChatSession): ContextUsage {
  return new ContextUsageBuilder(config, session).build();
}

export function resolveActiveChatModel(config: SiftConfig | null | undefined, session: ChatSession): string {
  if (typeof session?.model === 'string' && session.model.trim()) {
    return session.model.trim();
  }
  if (typeof config?.Runtime.Model === 'string' && config.Runtime.Model.trim()) {
    return config.Runtime.Model.trim();
  }
  return DEFAULT_LLAMA_MODEL;
}

function getChatUsageValue(value: unknown): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}


type BuildChatOptions = {
  promptPrefix?: string;
  webActionInstruction?: string;
};

function getActiveServerLlamaPreset(config: SiftConfig): ServerManagedLlamaPreset | null {
  const serverLlama = config.Server.LlamaCpp;
  const presets = serverLlama.Presets;
  if (presets.length === 0) {
    return null;
  }
  const activePresetId = serverLlama.ActivePresetId;
  return presets.find((preset) => preset.id === activePresetId) || presets[0] || null;
}

function shouldReplayReasoningContent(config: SiftConfig): boolean {
  const activePreset = getActiveServerLlamaPreset(config);
  return activePreset?.Reasoning === 'on' && activePreset.ReasoningContent === true;
}

function shouldPreserveThinking(config: SiftConfig, thinkingEnabled: boolean): boolean {
  if (!thinkingEnabled || !shouldReplayReasoningContent(config)) {
    return false;
  }
  return getActiveServerLlamaPreset(config)?.PreserveThinking === true;
}


export function buildChatHistoryMessages(
  config: SiftConfig,
  session: ChatSession,
): PlannerChatMessage[] {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const history: PlannerChatMessage[] = [];
  const replayThinking = shouldPreserveThinking(config, session.thinkingEnabled !== false);
  let pendingThinking = '';
  for (const message of messages) {
    const kind = typeof message.kind === 'string'
      ? message.kind
      : message.role === 'user'
        ? 'user_text'
        : 'assistant_answer';
    if (kind === 'assistant_thinking') {
      if (replayThinking) {
        pendingThinking = trimText(message.content);
      }
      continue;
    }
    if (kind === 'assistant_tool_call') {
      appendReplayToolMessages(history, message, pendingThinking);
      pendingThinking = '';
      continue;
    }
    const content = trimText(message.content);
    if (!content) {
      continue;
    }
    history.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
      ...(message.role === 'assistant' && pendingThinking ? { reasoning_content: pendingThinking } : {}),
    });
    pendingThinking = '';
  }
  if (pendingThinking) {
    history.push({ role: 'assistant', content: '', reasoning_content: pendingThinking });
  }
  return history;
}

function buildReplayToolCallId(messageId: unknown): string {
  const raw = typeof messageId === 'string' ? messageId : crypto.randomUUID();
  const safe = raw.replace(/[^A-Za-z0-9_-]/gu, '_');
  return `chat_tool_${safe}`;
}

function appendReplayToolMessages(history: PlannerChatMessage[], message: PersistedChatMessage, reasoningContent: string): void {
  const command = trimText(message.toolCallCommand) || trimText(message.content);
  const output = trimText(message.toolCallOutput) || trimText(message.toolCallOutputSnippet);
  if (!command && !output) {
    return;
  }
  const toolCallId = buildReplayToolCallId(message.id);
  history.push({
    role: 'assistant',
    content: '',
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    tool_calls: [buildReplayToolCall({ id: toolCallId, command })],
  });
  history.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: output || '(empty output)',
  });
}

export function buildRetainedWebToolCalls(session: ChatSession): RetainedWebToolCall[] {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const retained: RetainedWebToolCall[] = [];
  for (const message of messages) {
    if (message.kind !== 'assistant_tool_call') {
      continue;
    }
    const command = typeof message.toolCallCommand === 'string'
      ? message.toolCallCommand
      : typeof message.content === 'string'
        ? message.content
        : '';
    const parsed = parseWebToolCommand(command);
    if (parsed) {
      retained.push({
        ...parsed,
        command,
        exitCode: Number.isFinite(Number(message.toolCallExitCode)) ? Number(message.toolCallExitCode) : null,
        output: trimText(message.toolCallOutput) || trimText(message.toolCallOutputSnippet),
      });
    }
  }
  return retained;
}

export function buildChatSystemContent(_config: SiftConfig, _session: ChatSession, options: Pick<BuildChatOptions, 'promptPrefix' | 'webActionInstruction'> = {}): string {
  const systemPrompt = typeof options.promptPrefix === 'string' && options.promptPrefix.trim()
    ? options.promptPrefix.trim()
    : DEFAULT_CHAT_SYSTEM_PROMPT;
  return typeof options.webActionInstruction === 'string' && options.webActionInstruction.trim()
    ? `${systemPrompt}\n\n${options.webActionInstruction.trim()}`
    : systemPrompt;
}

export type ChatUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  thinkingTokens: number | null;
  outputTokensEstimated?: boolean;
  thinkingTokensEstimated?: boolean;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
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
  outputTokensEstimated?: boolean;
};
export type PersistTurn = {
  thinkingText: string;
  thinkingTokens?: number | null;
  thinkingTokensEstimated?: boolean;
  toolMessages: PersistToolMessage[];
};

type AppendChatOptions = {
  turns: PersistTurn[];
  maintainPerStepThinking?: boolean;
  inputTokens?: number | null;
  inputTokensEstimated?: boolean;
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
  outputTokensEstimated?: boolean;
  thinkingTokens?: number | null;
  thinkingTokensEstimated?: boolean;
  sourceRunId?: string | null;
  groundingStatus?: ChatGroundingStatus | null;
};

export function appendChatMessagesWithUsage(
  runtimeRoot: string,
  session: ChatSession,
  content: string,
  assistantContent: string,
  usage: Partial<ChatUsage> = {},
  options: AppendChatOptions = { turns: [] }
): ChatSession & { messages: PersistedChatMessage[] } {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  const promptCacheTokens = getChatUsageValue(usage.promptCacheTokens);
  const promptEvalTokens = getChatUsageValue(usage.promptEvalTokens);
  const completionTokens = getChatUsageValue(usage.completionTokens);
  const usageThinkingTokens = getChatUsageValue(usage.thinkingTokens);
  const usagePromptEvalDurationMs = getChatUsageValue(usage.promptEvalDurationMs);
  const usageGenerationDurationMs = getChatUsageValue(usage.generationDurationMs);
  const usagePromptTokensPerSecond = getChatUsageValue(usage.promptTokensPerSecond);
  const usageGenerationTokensPerSecond = getChatUsageValue(usage.generationTokensPerSecond);
  const explicitInputTokens = getChatUsageValue(options.inputTokens);
  const userTokens = explicitInputTokens ?? estimateTokenCount(content);
  const inputTokensEstimated = explicitInputTokens !== null ? options.inputTokensEstimated === true : true;
  const explicitOutputTokens = getChatUsageValue(options.outputTokens);
  const explicitThinkingTokens = getChatUsageValue(options.thinkingTokens);
  const outputTokens = explicitOutputTokens ?? completionTokens ?? estimateTokenCount(assistantContent);
  const outputTokensEstimated = explicitOutputTokens !== null
    ? options.outputTokensEstimated === true
    : completionTokens !== null
      ? usage.outputTokensEstimated === true
      : true;
  const thinkingTokens = explicitThinkingTokens ?? usageThinkingTokens ?? 0;
  const thinkingTokensEstimated = explicitThinkingTokens !== null
    ? options.thinkingTokensEstimated === true
    : usageThinkingTokens !== null
      ? usage.thinkingTokensEstimated === true
      : true;
  const sourceRunId = typeof options.sourceRunId === 'string' && options.sourceRunId.trim() ? options.sourceRunId : null;
  const groundingStatus = options.groundingStatus || null;
  messages.push({
    id: crypto.randomUUID(),
    role: 'user',
    kind: 'user_text',
    content,
    inputTokensEstimate: userTokens,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
    createdAtUtc: now,
    sourceRunId: null,
  });
  const turns = Array.isArray(options.turns) ? options.turns : [];
  let associatedToolTokens = 0;
  for (const turn of turns) {
    const thinkingText = String(turn.thinkingText || '');
    if (thinkingText.trim()) {
      const explicitThinkingTokenCount = getChatUsageValue(turn.thinkingTokens);
      const turnThinkingTokens = explicitThinkingTokenCount ?? estimateTokenCount(thinkingText);
      messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'assistant_thinking',
        content: thinkingText,
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: turnThinkingTokens,
        inputTokensEstimated: false,
        outputTokensEstimated: false,
        thinkingTokensEstimated: explicitThinkingTokenCount !== null ? turn.thinkingTokensEstimated !== false : true,
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
      const toolOutputTokensEstimated = explicitToolOutputTokens === null || toolMessage.outputTokensEstimated !== false;
      messages.push({
        id: toolMessageId,
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: typeof toolMessage.content === 'string' ? toolMessage.content : String(toolMessage.toolCallCommand || ''),
        inputTokensEstimate: 0,
        outputTokensEstimate: toolOutputTokens,
        thinkingTokens: 0,
        inputTokensEstimated: false,
        outputTokensEstimated: toolOutputTokensEstimated,
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
      associatedToolTokens += toolOutputTokens;
    }
  }
  const assistantMessageId = crypto.randomUUID();
  messages.push({
    id: assistantMessageId,
    role: 'assistant',
    kind: 'assistant_answer',
    content: assistantContent,
    inputTokensEstimate: 0,
    outputTokensEstimate: outputTokens,
    thinkingTokens,
    inputTokensEstimated: false,
    outputTokensEstimated,
    thinkingTokensEstimated,
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
    groundingStatus,
  });
  const retainedMessages = new ThinkingRetentionPolicy(options.maintainPerStepThinking !== false)
    .prunePersistedMessages(messages);
  const updated: ChatSession & { messages: PersistedChatMessage[] } = {
    ...session,
    updatedAtUtc: now,
    messages: retainedMessages,
  };
  saveChatSession(runtimeRoot, updated);
  return updated;
}


export function condenseChatSession(runtimeRoot: string, session: ChatSession): ChatSession {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  const keptCount = Math.min(messages.length, 2);
  const startIndex = Math.max(messages.length - keptCount, 0);
  const sourceMessages = startIndex > 0 ? messages.slice(0, startIndex) : messages;
  const condensedText = sourceMessages
    .map((message: PersistedChatMessage) => `${message.role}: ${String(message.content || '')}`)
    .join('\n');
  const condensedTail = condensedText.length > 2400 ? condensedText.slice(condensedText.length - 2400) : condensedText;
  const nextMessages = messages.map((message: PersistedChatMessage, index: number) => ({
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

export function buildPlanMarkdownFromRepoSearch(userPrompt: string, repoRoot: string, result: unknown): string {
  const normalized = result ? normalizeRepoSearchResult(result) : null;
  const tasks = normalized?.scorecard.tasks || [];
  const primaryTask = tasks[0] || null;
  const modelOutput = primaryTask?.finalOutput
    ? RepoSearchOutputFormatter.collapseRepeatedWholeOutput(primaryTask.finalOutput)
    : 'No final planner output was produced.';
  const commandEvidence: Array<{ command: string; output: string }> = [];
  for (let taskIndex = tasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
    const task = tasks[taskIndex];
    for (let commandIndex = task.commands.length - 1; commandIndex >= 0; commandIndex -= 1) {
      const command = task.commands[commandIndex];
      const commandText = command.displayCommand || command.command;
      const outputText = truncatePlanEvidence(command.output || command.outputSnippet);
      if (!commandText && !outputText) {
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
  const missingSignals = primaryTask?.missingSignals || [];
  if (missingSignals.length > 0) {
    lines.push(`- Missing expected evidence signals: ${missingSignals.join(', ')}`);
  } else {
    lines.push('- Verify that proposed changes preserve existing behavior and test coverage.');
  }
  lines.push('- Check for hidden coupling between chat flow state, session persistence, and model-request locking.');
  lines.push('- Validate repo-root input carefully to avoid running searches outside intended workspace.');
  lines.push('', '## Artifacts');
  lines.push(`- Transcript: \`${normalized?.transcriptPath || ''}\``);
  lines.push(`- Artifact: \`${normalized?.artifactPath || ''}\``);
  return lines.join('\n');
}

export function getScorecardTotal(scorecard: unknown, key: keyof RepoSearchScorecard['totals'] | string): number | null {
  const normalized = normalizeRepoSearchScorecard(scorecard);
  const value = normalized.totals[key as keyof RepoSearchScorecard['totals']];
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

function buildToolMessageFromCommand(command: RepoSearchCommandResult, turnsUsed: number): PersistToolMessage | null {
  const commandText = command.displayCommand || command.command;
  if (!commandText) {
    return null;
  }
  const turn = command.turn;
  if (turn === null || !Number.isInteger(turn) || turn < 1) {
    // No legacy fallback: a persisted command must carry its real planner turn.
    throw new Error(`TaskCommand for "${commandText}" has an invalid turn: ${String(command.turn)}`);
  }
  const output = command.output || command.outputSnippet;
  const outputTokens = getChatUsageValue(command.outputTokens);
  return {
    id: crypto.randomUUID(),
    content: commandText,
    toolCallCommand: commandText,
    toolCallTurn: turn,
    toolCallMaxTurns: turnsUsed,
    toolCallExitCode: command.exitCode,
    toolCallPromptTokenCount: null,
    toolCallOutputSnippet: output.length > 200 ? `${output.slice(0, 200)}...` : output,
    toolCallOutput: output,
    outputTokens,
    outputTokensEstimated: outputTokens === null || command.outputTokensEstimated !== false,
  };
}

export function buildPersistTurnsFromRepoSearchResult(result: unknown): PersistTurn[] {
  const normalized = result ? normalizeRepoSearchResult(result) : null;
  const tasks = normalized?.scorecard.tasks || [];
  const turns: PersistTurn[] = [];
  for (const task of tasks) {
    // Resolve a sane "of Y" for tool bubbles. turnsUsed must be a positive integer
    // no smaller than the largest command turn; otherwise fall back to that max
    // (never the raw command count, and never a value that would render "3 of 2").
    const commandTurns = task.commands
      .map((command) => command.turn)
      .filter((turn): turn is number => Number.isInteger(turn) && turn !== null && turn >= 1);
    const maxCommandTurn = commandTurns.length ? Math.max(...commandTurns) : 0;
    const rawTurnsUsed = task.turnsUsed;
    const turnsUsed = rawTurnsUsed && rawTurnsUsed >= maxCommandTurn
      ? rawTurnsUsed
      : Math.max(maxCommandTurn, 1);
    const toolsByTurn = new Map<number, PersistToolMessage[]>();
    for (const command of task.commands) {
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
    const thinkingTurns = Object.keys(task.turnThinking)
      .map((key) => Number(key))
      .filter((turn) => Number.isFinite(turn));
    const orderedTurns = [...new Set([...toolsByTurn.keys(), ...thinkingTurns])].sort((a, b) => a - b);
    for (const turn of orderedTurns) {
      const rawThinking = task.turnThinking[String(turn)];
      const thinkingText = typeof rawThinking === 'string' ? rawThinking.trim() : '';
      const toolMessages = toolsByTurn.get(turn) || [];
      if (!thinkingText && toolMessages.length === 0) {
        continue;
      }
      turns.push({ thinkingText, toolMessages });
    }
  }
  return turns;
}

export function buildRepoSearchMarkdown(userPrompt: string, repoRoot: string, result: unknown): string {
  const normalized = result ? normalizeRepoSearchResult(result) : null;
  const primaryTask = normalized?.scorecard.tasks[0] || null;
  const modelOutput = primaryTask?.finalOutput
    ? RepoSearchOutputFormatter.collapseRepeatedWholeOutput(primaryTask.finalOutput)
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
  lines.push(`- Transcript: \`${normalized?.transcriptPath || ''}\``);
  lines.push(`- Artifact: \`${normalized?.artifactPath || ''}\``);
  return lines.join('\n');
}

