import { randomUUID } from 'node:crypto';
import type { ChatRunRecorder } from './chat-run-recorder.js';
import { buildChatMessageId, DEFAULT_REASONING_EFFORT, isReplayableChatMessage, resolveEffectiveImagePixelCeiling, sumImageTokens } from '@siftkit/contracts';
import type { ContextUsage, ReasoningEffort, ReplayableChatMessage } from '@siftkit/contracts';
import {
  getActiveModelPreset,
  getConfiguredCompactionReserveTokens,
  getConfiguredEngineBaseUrl,
  getConfiguredEngineNumCtx,
} from '../config/getters.js';
import { overlayActivePreset } from '../config/overrides.js';
import type { ModelRuntimePreset, SiftConfig } from '../config/types.js';
import type { OptionalJsonValue } from '../lib/json-types.js';
import { resolveContextTokenBudget } from '../lib/context-token-budget.js';
import type { MockPlannerResponseInput } from '../planner-protocol/mock-response.js';
import type { JsonLogger, RepoSearchExecutionResult } from '../repo-search/types.js';
import type { RepoAgentRunResult } from '../repo-agent/run-schemas.js';
import {
  TranscriptCompactor,
  writePromptCacheEpochReset,
} from '../repo-search/engine/transcript-compactor.js';
import { TokenUsageTracker } from '../repo-search/engine/token-usage.js';
import { DEFAULT_TIMEOUT_MS, resolvePlannerThinkingFlags } from '../repo-search/engine/task-loop-support.js';
import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import { InferenceRequestBuilder } from '../llm-protocol/inference-request-builder.js';
import { buildPresetRequestDefaults } from '../inference-presets/preset-compatibility.js';
import { resolveImageTokenBudget } from '../llm-protocol/image-token-budget.js';
import {
  type ChatSession,
  type ChatMessage as PersistedChatTranscriptMessage,
  estimateTokenCount,
} from '../state/chat-sessions.js';
import { requireDurableToolResult } from './chat-tool-results.js';
import {
  parseWebToolCommand,
  type RetainedWebToolCall,
} from '../web-search/web-tool-command.js';
import {
  normalizeRepoSearchResult,
  normalizeRepoSearchScorecard,
  type RepoSearchScorecard,
} from './repo-search-scorecard-types.js';

const DEFAULT_CHAT_SYSTEM_PROMPT = 'general, coder friendly assistant';

export function trimText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Context usage reads the counts the engine measured and the row stores. Re-deriving them from
 * the row's text would give the composer bar a different number than the turn badge shows.
 */
function getMessageContextTokenEstimate(message: PersistedChatTranscriptMessage): number {
  if (message.kind === 'assistant_thinking') {
    return message.thinkingTokens;
  }
  return message.inputTokensEstimate
    + message.outputTokensEstimate
    + getMessageThinkingTokenEstimate(message)
    + sumImageTokens(message.imageMeta);
}

function getMessageThinkingTokenEstimate(message: PersistedChatTranscriptMessage): number {
  return message.thinkingTokens;
}

function getMessageToolTokenEstimate(message: PersistedChatTranscriptMessage): number {
  if (message.kind !== 'assistant_tool_call') {
    return 0;
  }
  return message.outputTokensEstimate;
}

function getMessageToolTokenFallbackEstimate(message: PersistedChatTranscriptMessage): number {
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
  imageUsedTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
  estimatedTokenFallbackTokens: number;
};

export function selectReplayableChatMessages(
  messages: readonly PersistedChatTranscriptMessage[],
): ReplayableChatMessage[] {
  return messages.filter((message): message is ReplayableChatMessage => (
    message.compressedIntoSummary !== true
    && isReplayableChatMessage(message)
  ));
}

export type { ContextUsage } from '@siftkit/contracts';

export function sessionUsesActiveModelPreset(config: SiftConfig, session: ChatSession): boolean {
  const modelPresetId = session.modelPresetId.trim();
  if (!modelPresetId) {
    throw new Error(`Chat session ${session.id} has no model preset identity.`);
  }
  return modelPresetId === getActiveModelPreset(config).id;
}

export function resolveChatSessionModel(config: SiftConfig, session: ChatSession): string {
  const model = sessionUsesActiveModelPreset(config, session)
    ? getActiveModelPreset(config).Model?.trim() ?? ''
    : session.modelPreset.Model?.trim() ?? '';
  if (!model) {
    throw new Error(`Chat session ${session.id} has an invalid model snapshot.`);
  }
  return model;
}

export function resolveChatSessionContextWindow(
  config: SiftConfig,
  session: ChatSession,
): number {
  if (sessionUsesActiveModelPreset(config, session)) {
    return getConfiguredEngineNumCtx(config);
  }

  const persistedContextWindow = session.modelPreset.NumCtx;
  if (Number.isInteger(persistedContextWindow) && persistedContextWindow > 0) {
    return persistedContextWindow;
  }
  throw new Error(`Chat session ${session.id} has an invalid context window snapshot.`);
}

/**
 * Effective config for a session: once the live active preset is a different one, the
 * snapshot's request-shaping fields are overlaid onto the active preset so every request
 * the session drives keeps the model, context size, and samplers it started with. The
 * snapshot `id` stays out of the overlay — it names a preset slot that may no longer
 * exist, and the surrounding preset list has to stay resolvable.
 */
export function resolveChatSessionConfig(config: SiftConfig, session: ChatSession): SiftConfig {
  if (sessionUsesActiveModelPreset(config, session)) {
    return config;
  }
  const { id, ...snapshotFields } = session.modelPreset;
  return overlayActivePreset(config, snapshotFields);
}

class ContextUsageBuilder {
  constructor(
    private readonly config: SiftConfig,
    private readonly session: ChatSession,
  ) {}

  build(): ContextUsage {
    const totals = this.buildTokenTotals();
    const warnThresholdTokens = Math.max(5000, Math.ceil(totals.contextWindowTokens * 0.1));
    const effectiveConfig = resolveChatSessionConfig(this.config, this.session);
    const activePreset = getActiveModelPreset(effectiveConfig);
    return {
      contextWindowTokens: totals.contextWindowTokens,
      usedTokens: totals.totalUsedTokens,
      chatUsedTokens: totals.chatUsedTokens,
      thinkingUsedTokens: totals.thinkingUsedTokens,
      toolUsedTokens: totals.toolUsedTokens,
      imageUsedTokens: totals.imageUsedTokens,
      totalUsedTokens: totals.totalUsedTokens,
      remainingTokens: totals.remainingTokens,
      warnThresholdTokens,
      shouldCondense: totals.remainingTokens <= warnThresholdTokens,
      estimatedTokenFallbackTokens: totals.estimatedTokenFallbackTokens,
      providerOverheadTokens: this.getProviderOverheadTokens(),
      effectiveImagePixelCeiling: resolveEffectiveImagePixelCeiling(
        resolveImageTokenBudget(activePreset),
        activePreset.VisionMaxImagePixels,
      ),
    };
  }

  private buildTokenTotals(): ContextUsageTokenTotals {
    const contextWindowTokens = resolveChatSessionContextWindow(this.config, this.session);
    const messages = selectReplayableChatMessages(
      Array.isArray(this.session.messages) ? this.session.messages : [],
    );
    const messageTokens = messages.reduce((sum, message) => sum + getMessageContextTokenEstimate(message), 0);
    const thinkingUsedTokens = messages.reduce((sum, message) => sum + getMessageThinkingTokenEstimate(message), 0);
    const toolUsedTokens = messages.reduce((sum, message) => sum + getMessageToolTokenEstimate(message), 0);
    const imageUsedTokens = messages.reduce((sum, message) => sum + sumImageTokens(message.imageMeta), 0);
    const chatUsedTokens = estimateTokenCount(DEFAULT_CHAT_SYSTEM_PROMPT) + messageTokens;
    const totalUsedTokens = chatUsedTokens + toolUsedTokens;
    const estimatedToolTokens = messages.reduce((sum, message) => sum + getMessageToolTokenFallbackEstimate(message), 0);
    return {
      contextWindowTokens,
      chatUsedTokens,
      thinkingUsedTokens,
      toolUsedTokens,
      imageUsedTokens,
      totalUsedTokens,
      remainingTokens: Math.max(contextWindowTokens - totalUsedTokens, 0),
      estimatedTokenFallbackTokens: chatUsedTokens + estimatedToolTokens,
    };
  }

  private getProviderOverheadTokens(): number {
    const thinkingEnabled = this.session.thinkingEnabled !== false;
    const config = this.config;
    const preset = getActiveModelPreset(config);
    // Derive the shape from the real request builder so the overhead estimate
    // cannot drift from what is actually sent; contents are counted separately.
    const request = overheadRequestBuilder.build({
      backend: preset.Backend,
      model: resolveChatSessionModel(this.config, this.session),
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: '' },
      ],
      tools: [],
      defaults: buildPresetRequestDefaults(preset),
      maxTokens: 0,
      thinking: {
        enabled: thinkingEnabled,
        reasoningContent: thinkingEnabled && shouldReplayReasoningContent(config),
        preserve: shouldPreserveThinking(config, thinkingEnabled),
        effort: resolveReasoningEffort(config),
      },
    });
    return estimateTokenCount(JSON.stringify(request));
  }
}

export function buildContextUsage(config: SiftConfig, session: ChatSession): ContextUsage {
  return new ContextUsageBuilder(config, session).build();
}


type BuildChatOptions = {
  webActionInstruction?: string;
  /** Rendered assistant-memory block (§11.6). Absent when memory is off or found nothing. */
  memoryContext?: string;
};

function getActiveServerModelPreset(config: SiftConfig): ModelRuntimePreset | null {
  const modelPresets = config.Server.ModelPresets;
  const presets = modelPresets.Presets;
  if (presets.length === 0) {
    return null;
  }
  const activePresetId = modelPresets.ActivePresetId;
  return presets.find((preset) => preset.id === activePresetId) || presets[0] || null;
}

const overheadRequestBuilder = new InferenceRequestBuilder();

function shouldReplayReasoningContent(config: SiftConfig): boolean {
  const activePreset = getActiveServerModelPreset(config);
  return activePreset?.Reasoning === 'on' && activePreset.ReasoningContent === true;
}

export function shouldPreserveThinking(config: SiftConfig, thinkingEnabled: boolean): boolean {
  if (!thinkingEnabled || !shouldReplayReasoningContent(config)) {
    return false;
  }
  return getActiveServerModelPreset(config)?.PreserveThinking === true;
}

function resolveReasoningEffort(config: SiftConfig): ReasoningEffort {
  return getActiveServerModelPreset(config)?.ReasoningEffort ?? DEFAULT_REASONING_EFFORT;
}


export function buildRetainedWebToolCalls(session: ChatSession): RetainedWebToolCall[] {
  const messages = selectReplayableChatMessages(Array.isArray(session.messages) ? session.messages : []);
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
        output: requireDurableToolResult(message),
      });
    }
  }
  return retained;
}

export function buildChatSystemContent(_config: SiftConfig, _session: ChatSession, options: BuildChatOptions = {}): string {
  const systemPrompt = DEFAULT_CHAT_SYSTEM_PROMPT;
  const webInstruction = typeof options.webActionInstruction === 'string'
    ? options.webActionInstruction.trim()
    : '';
  const memoryContext = typeof options.memoryContext === 'string'
    ? options.memoryContext.trim()
    : '';
  return [systemPrompt, webInstruction, memoryContext]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

/**
 * The single shape of a persisted compaction boundary. Both writers — the automatic
 * per-turn compaction and the manual condense — go through here so the rows they leave
 * behind stay indistinguishable to replay and to the transcript UI.
 */
export function buildCompactionSummaryRow(summaryText: string, createdAtUtc: string): PersistedChatTranscriptMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    kind: 'compaction_summary',
    content: summaryText,
    inputTokensEstimate: 0,
    outputTokensEstimate: estimateTokenCount(summaryText),
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: true,
    thinkingTokensEstimated: false,
    createdAtUtc,
    sourceRunId: null,
    compressedIntoSummary: false,
  };
}

export function getChatRunFailure(result: RepoSearchExecutionResult): string | null {
  const tasks = result.scorecard.tasks;
  if (result.scorecard.verdict === 'pass' && tasks.length > 0 && tasks.every((task) => task.reason === 'finish')) return null;
  return `Run did not finish normally: ${result.scorecard.failureReasons.length > 0 ? result.scorecard.failureReasons.join('; ') : tasks.map((task) => task.reason).join(', ') || 'missing terminal result'}.`;
}

export function buildRepoAgentResultMarkdown(result: RepoAgentRunResult): string {
  switch (result.status) {
    case 'completed':
      return result.output;
    case 'failed':
      return `Repo-agent run failed: ${result.error}${result.output ? `\n\n${result.output}` : ''}`;
    case 'aborted':
      return 'Repo-agent run stopped by user.';
    case 'approval_timeout':
      return `Repo-agent run timed out waiting for approval of \`${result.approval.command}\`.`;
    case 'approval_required':
      throw new Error('approval_required is not terminal for interactive chat runs.');
  }
}

export async function condenseChatSession(
  recorder: ChatRunRecorder,
  config: SiftConfig,
  session: ChatSession,
  mockResponses: MockPlannerResponseInput[] | undefined,
  logger: JsonLogger | null,
): Promise<ChatSession> {
  const effectiveConfig = resolveChatSessionConfig(config, session);
  const history = recorder.readHistory();
  const compressedMessageIds = (recorder.readSession().messages ?? []).map(message => message.id);
  recorder.recordContextInitialized({ messages: history, contextRevision: 0, turnBoundary: history.length });
  const cacheOrigin = {
    kind: 'new_epoch',
    flags: resolvePlannerThinkingFlags(effectiveConfig, session.thinkingEnabled !== false),
    tools: [],
  } as const;
  const contextBudget = resolveContextTokenBudget({
    totalContextTokens: getConfiguredEngineNumCtx(effectiveConfig),
    compactionReserveTokens: getConfiguredCompactionReserveTokens(effectiveConfig),
  });
  const compactor = new TranscriptCompactor({
    config: effectiveConfig,
    baseUrl: getConfiguredEngineBaseUrl(effectiveConfig),
    model: resolveChatSessionModel(config, session),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    totalContextTokens: contextBudget.totalContextTokens,
    compactionReserveTokens: contextBudget.compactionReserveTokens,
    useEstimatedTokensOnly: Array.isArray(mockResponses),
    mockResponses,
    tokenUsage: new TokenUsageTracker(effectiveConfig, Array.isArray(mockResponses)),
    logger,
    abortSignal: recorder.abortSignal,
  });
  // No system message: chat's system prompt is composed per request, and the compactor
  // summarizes everything below the system slot anyway. There is no turn either — this
  // is a user action on a session, not a step in a planner loop.
  const outcome = await compactor.compact({
    taskId: session.id,
    turn: null,
    messages: history,
    mockResponseIndex: 0,
    retention: { kind: 'none' },
    cacheOrigin,
  });

  recorder.recordContextSpliced({ expectedRevision: 0, contextRevision: 1, startIndex: 0, deleteCount: history.length,
    inserted: outcome.messages.map(message => message.role === 'assistant'
      ? { ...message, chatMessageId: buildChatMessageId(recorder.messageIdPrefix, { kind: 'summary', revision: 1 }) } : message),
    turnBoundary: outcome.messages.length, reason: 'compacted', compressedMessageIds, coalescedToolCallIds: [] });
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  writePromptCacheEpochReset(logger, {
    taskId: session.id,
    turn: null,
    droppedMessageCount: outcome.droppedMessageCount,
  });
  return recorder.readSession();
}

export function buildPlanRequestPrompt(userPrompt: string): string {
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

function truncatePlanEvidence(value: string, maxLength: number = 700): string {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

export function buildPlanMarkdownFromRepoSearch(userPrompt: string, repoRoot: string, result: OptionalJsonValue): string {
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
  lines.push('- Verify that proposed changes preserve existing behavior and test coverage.');
  lines.push('- Check for hidden coupling between chat flow state, session persistence, and model-request locking.');
  lines.push('- Validate repo-root input carefully to avoid running searches outside intended workspace.');
  lines.push('', '## Artifacts');
  lines.push(`- Transcript: \`${normalized?.transcriptPath || ''}\``);
  lines.push(`- Artifact: \`${normalized?.artifactPath || ''}\``);
  return lines.join('\n');
}

export function getScorecardTotal(scorecard: OptionalJsonValue, key: keyof RepoSearchScorecard['totals']): number | null {
  const normalized = normalizeRepoSearchScorecard(scorecard);
  const value = normalized.totals[key];
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

export function buildRepoSearchMarkdown(userPrompt: string, repoRoot: string, result: OptionalJsonValue): string {
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
