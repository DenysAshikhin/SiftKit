import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from '../lib/zod.js';
import { buildChatRunMessageIdPrefix, buildChatToolMessageId, ChatRepoAgentApprovalMessageSchema, DEFAULT_REASONING_EFFORT, ImageMetadataSchema, isReplayableChatMessage, PersistedChatTranscriptMessageSchema, resolveEffectiveImagePixelCeiling, sumImageTokens, ToolActivityKindSchema, ToolActivitySubjectSchema } from '@siftkit/contracts';
import type { ContextUsage, ImageMetadata, ReasoningEffort, ReplayableChatMessage, ToolActivityKind, ToolActivitySubject } from '@siftkit/contracts';
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
import type { ChatMessage as PlannerChatMessage } from '../repo-search/planner-protocol.js';
import type { MockPlannerResponseInput } from '../planner-protocol/mock-response.js';
import type { JsonLogger, RepoSearchExecutionResult } from '../repo-search/types.js';
import { admitImagesForPreset } from '../llm-protocol/preset-image-admission.js';
import type { RepoAgentRunResult } from '../repo-agent/run-schemas.js';
import type { ChatGroundingStatus } from '../repo-search/chat-grounding-policy.js';
import {
  buildCompactionSummaryMessage,
  TranscriptCompactor,
  writePromptCacheEpochReset,
} from '../repo-search/engine/transcript-compactor.js';
import { TokenUsageTracker } from '../repo-search/engine/token-usage.js';
import { foldTurnTokenRecords } from '../repo-search/engine/turn-token-record.js';
import type { TurnTokenRecord } from '../repo-search/engine/turn-token-record.js';
import { DEFAULT_TIMEOUT_MS, resolvePlannerThinkingFlags } from '../repo-search/engine/task-loop-support.js';
import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import { ImageRetentionPolicy } from '../image-retention-policy.js';
import { ThinkingRetentionPolicy } from '../thinking-retention-policy.js';
import { buildReplayToolCall } from '../llm-protocol/tool-call-parser.js';
import { InferenceRequestBuilder } from '../llm-protocol/inference-request-builder.js';
import { buildPresetRequestDefaults } from '../inference-presets/preset-compatibility.js';
import { resolveImageTokenBudget } from '../llm-protocol/image-token-budget.js';
import {
  type ChatSession,
  type ChatMessage as PersistedChatTranscriptMessage,
  estimateTokenCount,
  getChatSessionPath,
  readChatSessionFromPath,
  saveChatSession,
} from '../state/chat-sessions.js';
import type { ChatRepoAgentDecisionRecord } from './chat-repo-agent-types.js';
import { ChatMessageQueueStore, type ChatQueuedMessage } from '../state/chat-message-queue.js';
import { hydrateTerminalChatMessages, requireDurableToolResult } from './chat-tool-results.js';
import { getRuntimeDatabase, type RuntimeDatabase } from '../state/runtime-db.js';
import { buildUserContent, parseImageDataUrls } from '../llm-protocol/image-attachments.js';
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

/**
 * Deleted attachments are stored as a count, never written into the message text. The notice
 * is composed here so the model does not read a dangling reference to an image that is gone.
 */
function appendRemovedImageNotice(content: string, removedImageCount: number): string {
  if (removedImageCount <= 0) {
    return content;
  }
  const notice = removedImageCount === 1
    ? '[1 image removed]'
    : `[${removedImageCount} images removed]`;
  return content ? `${content}\n${notice}` : notice;
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

function getChatUsageValue(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
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

function shouldPreserveThinking(config: SiftConfig, thinkingEnabled: boolean): boolean {
  if (!thinkingEnabled || !shouldReplayReasoningContent(config)) {
    return false;
  }
  return getActiveServerModelPreset(config)?.PreserveThinking === true;
}

function resolveReasoningEffort(config: SiftConfig): ReasoningEffort {
  return getActiveServerModelPreset(config)?.ReasoningEffort ?? DEFAULT_REASONING_EFFORT;
}


export function buildChatHistoryMessages(
  config: SiftConfig,
  session: ChatSession,
): PlannerChatMessage[] {
  const messages = selectReplayableChatMessages(
    Array.isArray(session.messages) ? session.messages : [],
  );
  const history: PlannerChatMessage[] = [];
  const replayThinking = shouldPreserveThinking(config, session.thinkingEnabled !== false);
  let pendingThinking = '';
  for (const message of messages) {
    const kind = message.kind;
    if (kind === 'compaction_summary') {
      const summaryText = trimText(message.content);
      if (summaryText) {
        history.push(buildCompactionSummaryMessage(summaryText));
      }
      pendingThinking = '';
      continue;
    }
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
    if (kind === 'tool_image') {
      const toolImages = message.images ?? [];
      if (toolImages.length > 0) {
        const toolText = appendRemovedImageNotice(trimText(message.content), message.removedImageCount ?? 0);
        history.push({ role: 'user', content: buildUserContent(toolText, toolImages) });
      }
      continue;
    }
    if (kind === 'repo_agent_approval') {
      history.push({ role: 'user', content: `[repo-agent approval] ${message.content}` });
      pendingThinking = '';
      continue;
    }
    const content = appendRemovedImageNotice(trimText(message.content), message.removedImageCount ?? 0);
    const messageImages = message.images ?? [];
    if (!content && messageImages.length === 0) {
      continue;
    }
    history.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'user'
        ? buildUserContent(content, messageImages)
        : content,
      ...(message.role === 'assistant' && pendingThinking ? { reasoning_content: pendingThinking } : {}),
    });
    pendingThinking = '';
  }
  if (pendingThinking) {
    history.push({ role: 'assistant', content: '', reasoning_content: pendingThinking });
  }
  new ImageRetentionPolicy(getActiveModelPreset(config).VisionImageRetention).prune(history);
  return history;
}

function buildReplayToolCallId(messageId: string): string {
  const raw = typeof messageId === 'string' ? messageId : randomUUID();
  const safe = raw.replace(/[^A-Za-z0-9_-]/gu, '_');
  return `chat_tool_${safe}`;
}

/**
 * The persisted result is replayed exactly as it was inserted — no trimming, no refitting, and
 * never the preview. A completed row without its full result is a history-integrity failure that
 * names the row; replaying a 200-character preview there is what made a stopped run forget what
 * it read.
 */
function resolveReplayToolOutput(message: ReplayableChatMessage & { kind: 'assistant_tool_call' }): string {
  return requireDurableToolResult(message);
}

function appendReplayToolMessages(
  history: PlannerChatMessage[],
  message: ReplayableChatMessage & { kind: 'assistant_tool_call' },
  reasoningContent: string,
): void {
  const command = trimText(message.toolCallCommand) || trimText(message.content);
  const output = resolveReplayToolOutput(message);
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
    content: output,
  });
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
        output: resolveReplayToolOutput(message),
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

export type ChatUsage = {
  promptTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
};


export type PersistToolMessage = {
  id: string;
  content: string;
  toolCallCommand: string;
  toolCallActivityKind: ToolActivityKind;
  toolCallActivitySubject: ToolActivitySubject;
  toolCallTurn: number;
  toolCallMaxTurns: number;
  toolCallExitCode: number | null;
  toolCallPromptTokenCount?: number | null;
  toolCallOutputSnippet: string;
  toolCallOutput: string;
  outputTokens: number | null;
  outputTokensEstimated?: boolean;
  images?: string[];
  imageMeta?: ImageMetadata[];
};
export type PersistTurn = {
  thinkingText: string;
  thinkingTokens?: number | null;
  thinkingTokensEstimated?: boolean;
  toolMessages: PersistToolMessage[];
};

export type PersistQueuedMessage = Pick<ChatQueuedMessage, 'id' | 'content' | 'images' | 'deliveredTurn'>;

type AppendChatOptions = {
  turns: PersistTurn[];
  turnRecords: TurnTokenRecord[];
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
  sourceRunId?: string | null;
  /** Raw summary text when this turn compacted; marks every earlier row as compacted. */
  compactionSummary?: string | null;
  groundingStatus?: ChatGroundingStatus | null;
  images?: string[];
  imageMeta?: ImageMetadata[];
  queuedMessages?: PersistQueuedMessage[];
};

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

export function buildChatUserMessage(
  content: string,
  images: string[],
  imageMeta: ImageMetadata[],
  createdAtUtc: string,
  id: string = randomUUID(),
): PersistedChatTranscriptMessage {
  return PersistedChatTranscriptMessageSchema.parse({
    id,
    role: 'user',
    kind: 'user_text',
    content,
    inputTokensEstimate: estimateTokenCount(content),
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated: true,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
    createdAtUtc,
    sourceRunId: null,
    images,
    imageMeta,
  });
}

export function getChatRunFailure(result: RepoSearchExecutionResult): string | null {
  const tasks = result.scorecard.tasks;
  if (result.scorecard.verdict === 'pass' && tasks.length > 0 && tasks.every((task) => task.reason === 'finish')) return null;
  return `Run did not finish normally: ${result.scorecard.failureReasons.length > 0 ? result.scorecard.failureReasons.join('; ') : tasks.map((task) => task.reason).join(', ') || 'missing terminal result'}.`;
}

export function buildQueuedChatUserMessage(
  session: ChatSession,
  delivery: Pick<PersistQueuedMessage, 'id' | 'content' | 'images'>,
  createdAtUtc: string,
): PersistedChatTranscriptMessage {
  const images = admitImagesForPreset(session.modelPreset, delivery.images);
  return buildChatUserMessage(delivery.content, images.map((image) => image.dataUrl), images.map((image) => image.metadata), createdAtUtc, delivery.id);
}

export type BuildChatStoppedTurnInput = {
  content: string;
  images: string[];
  imageMeta: ImageMetadata[];
  transcriptMessages: PersistedChatTranscriptMessage[];
  approvalMessages: PersistedChatTranscriptMessage[];
  queuedMessages?: PersistQueuedMessage[];
};

/** Reconcile only the new turn, using the recorded complete tool-batch boundary. */
function mergeQueueDeliveries(
  messages: PersistedChatTranscriptMessage[],
  deliveries: readonly PersistQueuedMessage[],
  session: ChatSession,
): PersistedChatTranscriptMessage[] {
  if (deliveries.length === 0) return messages;
  const first = messages[0];
  if (!first || first.kind !== 'user_text') throw new Error('Queued history requires the initial user row.');
  const ids = new Set(deliveries.map((message) => message.id));
  if (ids.size !== deliveries.length) throw new Error('Duplicate queued delivery identity.');
  const body = messages.slice(1).filter((message) => !ids.has(message.id));
  const initial: PersistedChatTranscriptMessage[] = [];
  const after = new Map<number, PersistedChatTranscriptMessage[]>();
  let previousBoundary = 0;
  for (const delivery of deliveries) {
    const boundary = z.number().int().nonnegative().parse(delivery.deliveredTurn);
    if (boundary < previousBoundary) throw new Error(`Queued delivery ${delivery.id} violates FIFO boundaries.`);
    previousBoundary = boundary;
    const row = buildQueuedChatUserMessage(session, delivery, first.createdAtUtc);
    if (boundary === 0) { initial.push(row); continue; }
    let index = -1;
    for (const [position, message] of body.entries()) {
      if (message.kind === 'assistant_tool_call' && message.toolCallTurn === boundary) index = position;
    }
    if (index < 0) throw new Error(`Queued delivery ${delivery.id} has no completed batch boundary ${boundary}.`);
    while (body[index + 1]?.kind === 'tool_image') index += 1;
    const group = after.get(index) ?? [];
    group.push(row);
    after.set(index, group);
  }
  return [
    ...(initial.length > 0 ? initial : [first]),
    ...body.flatMap((message, index) => [message, ...(after.get(index) ?? [])]),
  ];
}

/** The engine request the stopped turn ran as: the key its canonical tool evidence is stored under. */
export type AppendChatStoppedTurnInput = Omit<BuildChatStoppedTurnInput, 'queuedMessages'> & { requestId: string };

export function buildChatSessionWithStoppedTurn(
  session: ChatSession,
  input: BuildChatStoppedTurnInput,
): ChatSession & { messages: PersistedChatTranscriptMessage[] } {
  const now = new Date().toISOString();
  const transcriptMessages = PersistedChatTranscriptMessageSchema.array().parse(input.transcriptMessages);
  if (transcriptMessages.some((message) => message.role !== 'assistant' && message.kind !== 'user_text' && message.kind !== 'tool_image')) {
    throw new Error('Stopped chat transcript contains an invalid user message kind.');
  }
  if (transcriptMessages.filter((message) => message.kind === 'assistant_answer').length > 1) {
    throw new Error('Stopped chat transcript contains multiple answer rows.');
  }
  for (const message of transcriptMessages) {
    if (message.kind === 'assistant_tool_call' && message.toolCallStatus === 'done') {
      requireDurableToolResult(message);
    }
  }
  const approvalMessages = ChatRepoAgentApprovalMessageSchema.array().parse(input.approvalMessages);
  return {
    ...session,
    updatedAtUtc: now,
    messages: [
      ...(session.messages ?? []),
      ...mergeQueueDeliveries([
        buildChatUserMessage(input.content, input.images, input.imageMeta, now),
        ...approvalMessages,
        ...transcriptMessages,
      ], input.queuedMessages ?? [], session),
    ],
  };
}

function getRuntimeDatabaseForRoot(runtimeRoot: string): RuntimeDatabase {
  return getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite'));
}

/**
 * The one durable-write path for a stopped turn, whatever route ran it. The incoming turn's
 * completed tool rows carry previews from the live stream; they are hydrated from the run's own
 * transcript here, before the pure builder validates and the session is saved. Earlier messages
 * of the session are neither inspected nor rebuilt.
 */
export function appendChatStoppedTurn(
  runtimeRoot: string,
  session: ChatSession,
  input: AppendChatStoppedTurnInput,
): ChatSession & { messages: PersistedChatTranscriptMessage[] } {
  const { requestId, ...turn } = input;
  const database = getRuntimeDatabaseForRoot(runtimeRoot);
  return database.transaction(() => {
  const queue = new ChatMessageQueueStore(database);
  const deliveries = queue.listDelivered(session.id, requestId);
  const updated = buildChatSessionWithStoppedTurn(session, {
    ...turn,
    queuedMessages: deliveries,
    transcriptMessages: hydrateTerminalChatMessages(
      getRuntimeDatabaseForRoot(runtimeRoot),
      requestId,
      turn.transcriptMessages,
    ),
  });
  saveChatSession(runtimeRoot, updated);
  queue.deleteIncorporated(session.id, requestId);
  return updated;
  })();
}

export function buildChatSessionWithAppendedTurn(
  session: ChatSession,
  content: string,
  assistantContent: string,
  usage: Partial<ChatUsage> = {},
  options: AppendChatOptions = { turns: [], turnRecords: [] }
): ChatSession & { messages: PersistedChatTranscriptMessage[] } {
  const now = new Date().toISOString();
  const compactionSummary = typeof options.compactionSummary === 'string' ? options.compactionSummary.trim() : '';
  // The run compacted against the replayed history, so the boundary is exactly
  // "everything that existed before this turn". Marking here — in the same
  // saveChatSession write as the turn's own rows — is what makes the flags and the
  // summary row impossible to separate.
  const messages = (Array.isArray(session.messages) ? session.messages : [])
    .map((message) => (compactionSummary ? { ...message, compressedIntoSummary: true } : message));
  if (compactionSummary) {
    messages.push(buildCompactionSummaryRow(compactionSummary, now));
  }
  const promptCacheTokens = getChatUsageValue(usage.promptCacheTokens);
  const promptEvalTokens = getChatUsageValue(usage.promptEvalTokens);
  const usagePromptEvalDurationMs = getChatUsageValue(usage.promptEvalDurationMs);
  const usageGenerationDurationMs = getChatUsageValue(usage.generationDurationMs);
  const usagePromptTokensPerSecond = getChatUsageValue(usage.promptTokensPerSecond);
  const usageGenerationTokensPerSecond = getChatUsageValue(usage.generationTokensPerSecond);
  const explicitInputTokens = getChatUsageValue(options.inputTokens);
  const userTokens = explicitInputTokens ?? estimateTokenCount(content);
  const inputTokensEstimated = explicitInputTokens !== null ? options.inputTokensEstimated === true : true;
  // Turn records are the only measured source of generated output. A caller that ran no engine
  // turns at all — a provided assistant turn, or a run that failed before the engine produced a
  // result — has nothing to attribute, so its answer text is estimated and marked as such.
  const recordTotals = options.turnRecords.length > 0 ? foldTurnTokenRecords(options.turnRecords) : null;
  const outputTokens = recordTotals?.outputTokens ?? estimateTokenCount(assistantContent);
  const outputTokensEstimated = recordTotals === null || recordTotals.outputTokensEstimatedCount > 0;
  // Per-step rows own thinking. The answer row owns only the answer, so no path can both
  // aggregate onto the answer row and emit step rows for the same tokens.
  const thinkingTokens = 0;
  const thinkingTokensEstimated = false;
  const sourceRunId = typeof options.sourceRunId === 'string' && options.sourceRunId.trim() ? options.sourceRunId : null;
  const groundingStatus = options.groundingStatus || null;
  const turnStart = messages.length;
  messages.push({
    ...buildChatUserMessage(
      content,
      options.images ?? [],
      options.imageMeta ?? [],
      now,
    ),
    inputTokensEstimate: userTokens,
    inputTokensEstimated,
  });
  const turns = Array.isArray(options.turns) ? options.turns : [];
  for (const turn of turns) {
    const thinkingText = String(turn.thinkingText || '');
    if (thinkingText.trim()) {
      const explicitThinkingTokenCount = getChatUsageValue(turn.thinkingTokens);
      const turnThinkingTokens = explicitThinkingTokenCount ?? estimateTokenCount(thinkingText);
      messages.push({
        id: randomUUID(),
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
      const toolMessageId = typeof toolMessage.id === 'string' && toolMessage.id.trim() ? toolMessage.id : randomUUID();
      const toolOutput = requireDurableToolResult({ id: toolMessageId, sourceRunId, toolCallOutput: toolMessage.toolCallOutput });
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
        toolCallCommand: typeof toolMessage.toolCallCommand === 'string' ? toolMessage.toolCallCommand : String(toolMessage.content || ''),
        toolCallActivityKind: ToolActivityKindSchema.parse(toolMessage.toolCallActivityKind),
        toolCallActivitySubject: ToolActivitySubjectSchema.parse(toolMessage.toolCallActivitySubject),
        toolCallTurn: z.number().int().positive().parse(toolMessage.toolCallTurn),
        toolCallMaxTurns: z.number().int().positive().parse(toolMessage.toolCallMaxTurns),
        toolCallExitCode: Number.isFinite(Number(toolMessage.toolCallExitCode)) ? Number(toolMessage.toolCallExitCode) : null,
        toolCallPromptTokenCount: Number.isFinite(Number(toolMessage.toolCallPromptTokenCount)) ? Number(toolMessage.toolCallPromptTokenCount) : null,
        toolCallOutputSnippet: typeof toolMessage.toolCallOutputSnippet === 'string' ? toolMessage.toolCallOutputSnippet : '',
        toolCallOutput: toolOutput,
        toolCallStatus: 'done',
        createdAtUtc: now,
        sourceRunId,
      });
      const toolImages = Array.isArray(toolMessage.images)
        ? parseImageDataUrls(toolMessage.images)
        : [];
      if (toolImages.length > 0) {
        messages.push({
          id: randomUUID(),
          role: 'user',
          kind: 'tool_image',
          content: '',
          inputTokensEstimate: 0,
          outputTokensEstimate: 0,
          thinkingTokens: 0,
          inputTokensEstimated: false,
          outputTokensEstimated: false,
          thinkingTokensEstimated: false,
          createdAtUtc: now,
          sourceRunId,
          images: toolImages,
          imageMeta: toolMessage.imageMeta
            ? ImageMetadataSchema.array().parse(toolMessage.imageMeta)
            : [],
        });
      }
    }
  }
  const assistantMessageId = randomUUID();
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
    thinkingContent: '',
    createdAtUtc: now,
    sourceRunId,
    groundingStatus,
  });
  messages.splice(turnStart, messages.length - turnStart, ...mergeQueueDeliveries(messages.slice(turnStart), options.queuedMessages ?? [], session));
  const retainedMessages = new ThinkingRetentionPolicy(options.maintainPerStepThinking !== false)
    .prunePersistedMessages(messages);
  const updated: ChatSession & { messages: PersistedChatTranscriptMessage[] } = {
    ...session,
    updatedAtUtc: now,
    messages: retainedMessages,
  };
  return updated;
}

export function appendChatMessagesWithUsage(
  runtimeRoot: string,
  session: ChatSession,
  content: string,
  assistantContent: string,
  usage: Partial<ChatUsage> = {},
  options: Omit<AppendChatOptions, 'queuedMessages'> = { turns: [], turnRecords: [] },
): ChatSession & { messages: PersistedChatTranscriptMessage[] } {
  const database = getRuntimeDatabaseForRoot(runtimeRoot);
  return database.transaction(() => {
  const queue = new ChatMessageQueueStore(database);
  const deliveries = options.sourceRunId ? queue.listDelivered(session.id, options.sourceRunId) : [];
  const updated = buildChatSessionWithAppendedTurn(
    session,
    content,
    assistantContent,
    usage,
    { ...options, queuedMessages: deliveries },
  );
  saveChatSession(runtimeRoot, updated);
  if (options.sourceRunId) queue.deleteIncorporated(session.id, options.sourceRunId);
  return updated;
  })();
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

function buildRepoAgentApprovalMessages(
  decisions: ChatRepoAgentDecisionRecord[],
  runId: string,
): PersistedChatTranscriptMessage[] {
  return decisions.map((decision) => {
    const reason = decision.decision.decision === 'deny' ? ` — ${decision.decision.reason}` : '';
    const content = `${decision.decision.decision} ${decision.approval.toolName}: ${decision.approval.command}${reason}`;
    return ChatRepoAgentApprovalMessageSchema.parse({
      id: randomUUID(),
      role: 'user',
      kind: 'repo_agent_approval',
      content,
      inputTokensEstimate: estimateTokenCount(content),
      outputTokensEstimate: 0,
      thinkingTokens: 0,
      inputTokensEstimated: true,
      outputTokensEstimated: false,
      thinkingTokensEstimated: false,
      createdAtUtc: decision.decidedAtUtc,
      sourceRunId: runId,
      approvalDecision: decision.decision.decision,
      approvalToolName: decision.approval.toolName,
      approvalCommand: decision.approval.command,
      approvalReason: decision.decision.decision === 'deny' ? decision.decision.reason : null,
    });
  });
}

export function appendChatRepoAgentMessages(
  runtimeRoot: string,
  sessionId: string,
  input: {
    content: string;
    images: string[];
    decisions: ChatRepoAgentDecisionRecord[];
    result: RepoAgentRunResult;
    /**
     * The engine request this turn ran as. Every row of the turn is stamped with it, because that
     * is the id the run's transcript, its run log and its tool-row identities are all keyed on —
     * the repo-agent run id names the session, not the evidence.
     */
    requestId: string;
    turns: PersistTurn[];
    turnRecords: TurnTokenRecord[];
    terminalMessages: PersistedChatTranscriptMessage[];
    maintainPerStepThinking: boolean;
  },
): ChatSession {
  const database = getRuntimeDatabaseForRoot(runtimeRoot);
  return database.transaction(() => {
  const queue = new ChatMessageQueueStore(database);
  const deliveries = queue.listDelivered(sessionId, input.requestId);
  const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
  const session = readChatSessionFromPath(sessionPath);
  if (!session) {
    throw new Error(`Chat session disappeared before repo-agent persistence: ${sessionId}`);
  }
  const approvalMessages = buildRepoAgentApprovalMessages(input.decisions, input.requestId);
  if (input.result.status === 'aborted') {
    return appendChatStoppedTurn(runtimeRoot, session, {
      content: input.content,
      images: input.images,
      imageMeta: [],
      transcriptMessages: input.terminalMessages,
      approvalMessages,
      requestId: input.requestId,
    });
  }
  // A provider failure has no scorecard, but its completed tools and partial text still exist —
  // hydrated from the run's transcript, exactly as a stopped turn's are.
  const terminalEvidence = input.turns.length === 0
    ? hydrateTerminalChatMessages(getRuntimeDatabaseForRoot(runtimeRoot), input.requestId, input.terminalMessages)
    : [];
  const terminalAnswer = terminalEvidence.find((message) => message.kind === 'assistant_answer');
  const persisted = buildChatSessionWithAppendedTurn(
    session,
    input.content,
    terminalAnswer?.content ?? buildRepoAgentResultMarkdown(input.result),
    {},
    {
      turns: input.turns,
      turnRecords: input.turnRecords,
      maintainPerStepThinking: input.maintainPerStepThinking,
      sourceRunId: input.requestId,
      images: input.images,
    },
  );
  const assistantMessage = persisted.messages[persisted.messages.length - 1];
  if (!assistantMessage || assistantMessage.kind !== 'assistant_answer') {
    throw new Error(`Repo-agent persistence did not produce an assistant answer: ${sessionId}`);
  }
  const withApprovals = {
    ...persisted,
    messages: new ThinkingRetentionPolicy(input.maintainPerStepThinking).prunePersistedMessages([
      ...persisted.messages.slice(0, -1),
      ...terminalEvidence.filter((message) => message.kind !== 'assistant_answer'),
      ...approvalMessages,
      assistantMessage,
    ]),
  };
  const previousCount = session.messages?.length ?? 0;
  withApprovals.messages.splice(previousCount, withApprovals.messages.length - previousCount,
    ...mergeQueueDeliveries(withApprovals.messages.slice(previousCount), deliveries, session));
  saveChatSession(runtimeRoot, withApprovals);
  queue.deleteIncorporated(sessionId, input.requestId);
  const authoritative = readChatSessionFromPath(sessionPath);
  if (!authoritative) {
    throw new Error(`Chat session disappeared after repo-agent persistence: ${sessionId}`);
  }
  return authoritative;
  })();
}


/**
 * Manual condense: the same summarizer the engine runs at budget, invoked directly
 * against the session's replayed history. One summarization call, no planner run.
 */
export async function condenseChatSession(
  runtimeRoot: string,
  config: SiftConfig,
  session: ChatSession,
  mockResponses: MockPlannerResponseInput[] | undefined,
  logger: JsonLogger | null,
): Promise<ChatSession & { messages: PersistedChatTranscriptMessage[] }> {
  const effectiveConfig = resolveChatSessionConfig(config, session);
  const history = buildChatHistoryMessages(effectiveConfig, session);
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
    abortSignal: undefined,
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

  const now = new Date().toISOString();
  const messages: PersistedChatTranscriptMessage[] = (Array.isArray(session.messages) ? session.messages : [])
    .map((message: PersistedChatTranscriptMessage) => ({ ...message, compressedIntoSummary: true }));
  messages.push(buildCompactionSummaryRow(outcome.summaryText, now));
  const updated: ChatSession & { messages: PersistedChatTranscriptMessage[] } = { ...session, updatedAtUtc: now, messages };
  saveChatSession(runtimeRoot, updated);
  writePromptCacheEpochReset(logger, {
    taskId: session.id,
    turn: null,
    droppedMessageCount: outcome.droppedMessageCount,
  });
  return updated;
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

function buildToolMessageFromCommand(
  command: RepoSearchCommandResult,
  maxTurns: number,
  requestId: string,
): PersistToolMessage | null {
  const commandText = command.displayCommand || command.command;
  if (!commandText) {
    return null;
  }
  const turn = command.turn;
  if (turn === null || !Number.isInteger(turn) || turn < 1) {
    // No legacy fallback: a persisted command must carry its real planner turn.
    throw new Error(`TaskCommand for "${commandText}" has an invalid turn: ${String(command.turn)}`);
  }
  // The scorecard carries the model-visible result; the snippet is a preview and never stands in
  // for it. An archived scorecard without a call identity keeps a random id and is matched
  // canonically by the repair path instead.
  const output = command.output;
  const outputTokens = command.outputTokens;
  return {
    id: command.toolCallId && requestId
      ? buildChatToolMessageId(buildChatRunMessageIdPrefix(requestId), command.toolCallId)
      : randomUUID(),
    content: commandText,
    toolCallCommand: commandText,
    toolCallActivityKind: ToolActivityKindSchema.parse(command.activityKind),
    toolCallActivitySubject: ToolActivitySubjectSchema.parse(command.activitySubject),
    toolCallTurn: turn,
    toolCallMaxTurns: maxTurns,
    toolCallExitCode: command.exitCode,
    toolCallPromptTokenCount: command.promptTokenCount,
    toolCallOutputSnippet: output.length > 200 ? `${output.slice(0, 200)}...` : output,
    toolCallOutput: output,
    outputTokens,
    outputTokensEstimated: outputTokens === null || command.outputTokensEstimated !== false,
    images: command.imageDataUrls,
    imageMeta: command.imageMeta,
  };
}

export function buildPersistTurnsFromRepoSearchResult(result: OptionalJsonValue): PersistTurn[] {
  const normalized = result ? normalizeRepoSearchResult(result) : null;
  const tasks = normalized?.scorecard.tasks || [];
  const requestId = normalized?.requestId ?? '';
  const turns: PersistTurn[] = [];
  for (const task of tasks) {
    const toolsByTurn = new Map<number, PersistToolMessage[]>();
    for (const command of task.commands) {
      const message = buildToolMessageFromCommand(command, task.maxTurns, requestId);
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
