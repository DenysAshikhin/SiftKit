import * as crypto from 'node:crypto';
import type { Dict } from '../lib/types.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import type { ChatGroundingStatus } from '../repo-search/chat-grounding-policy.js';
import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import {
  type ChatSession,
  estimateTokenCount,
  saveChatSession,
} from '../state/chat-sessions.js';
import { DEFAULT_LLAMA_MODEL } from './config-store.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';
import { getDisplayToolCommand } from './tool-command-display.js';

const DEFAULT_CHAT_SYSTEM_PROMPT = 'general, coder friendly assistant';

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


type BuildChatOptions = {
  promptPrefix?: string;
  webActionInstruction?: string;
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


export function buildChatHistoryMessages(
  _config: Dict,
  session: ChatSession,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = Array.isArray(session.messages) ? session.messages as Dict[] : [];
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.kind === 'assistant_thinking' || message.kind === 'assistant_tool_call') {
      continue; // internal-logic steps are not replayed as conversation turns
    }
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) {
      continue;
    }
    history.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return history;
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
  groundingStatus?: ChatGroundingStatus | null;
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
  const groundingStatus = options.groundingStatus || null;
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
    groundingStatus,
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
