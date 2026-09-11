import { renderTaskTranscript } from '../planner-protocol.js';
import { buildChatMessageId } from '@siftkit/contracts';
import { applyLiveChatContextRevisions } from '../../state/chat-history-revisions.js';
import { COMPACTION_SUMMARY_MARKER } from './transcript-compactor.js';
import {
  ChatContextInitSchema,
  ChatContextSpliceSchema,
  type ChatContextSpliceReason,
  type ChatContextSplice,
  type ChatMessage,
} from '../planner-chat-message.js';
import type { ChatContextRecorder } from './chat-run-evidence.js';
import {
  buildToolBatchMessages,
  buildToolExchangeMessages,
  resolveTrailingUserSlot,
  type ToolBatchOutcome,
  type ToolTranscriptAction,
} from '../../tool-call-messages.js';
import { ThinkingRetentionPolicy } from '../../thinking-retention-policy.js';
import { ImageRetentionPolicy } from '../../image-retention-policy.js';
import { buildUserContent, countContentImages } from '../../llm-protocol/image-attachments.js';

/**
 * The sole owner of the planner's mutable history. Callers read a readonly view and ask for named
 * mutations; every one of them becomes a validated splice against an expected revision, committed
 * to the recorder before it is applied, so a recovered run replays exactly what the live run did.
 */
export class TranscriptManager {
  private readonly messages: ChatMessage[];
  private readonly liveImagePathKeys: Set<string>;
  private readonly recorder: ChatContextRecorder | null;
  private lastLoggedMessageCount = 0;
  private contextRevisionValue = 0;
  private currentTurnStartIndexValue: number;
  private forcedFinishCountdownIndex = -1;
  private modelTurn = 1;
  private appliedHistoryRevision = 0;

  beginTurn(turn: number): void { this.modelTurn = turn; }

  /** Incremented by every applied mutation; a splice names the revision it expects to amend. */
  get contextRevision(): number {
    return this.contextRevisionValue;
  }

  /**
   * Absolute index of the current turn's first message: after system and the persisted
   * history at construction, and whatever a compaction install says afterwards.
   */
  get currentTurnStartIndex(): number {
    return this.currentTurnStartIndexValue;
  }

  constructor(options: {
    systemPromptContent: string;
    historyMessages: readonly ChatMessage[];
    initialUserContent: string;
    initialUserImages: readonly string[];
    initialFollowupMessages?: readonly ChatMessage[];
    initialQueueMessageIds?: string[];
    liveImagePathKeys: Set<string>;
    contextRecorder?: ChatContextRecorder;
  }) {
    this.liveImagePathKeys = options.liveImagePathKeys;
    this.recorder = options.contextRecorder ?? null;
    const initialMessages: ChatMessage[] = [
      { role: 'system', content: options.systemPromptContent },
      ...options.historyMessages,
      { role: 'user', content: buildUserContent(options.initialUserContent, options.initialUserImages),
        ...(this.recorder === null ? {} : { chatMessageId: this.recorder.userMessageId }) },
      ...(options.initialFollowupMessages ?? []),
    ];
    const revisions = this.recorder?.readHistoryRevisions() ?? [];
    const pending = revisions.slice(this.recorder?.historyRevision ?? 0);
    this.messages = applyLiveChatContextRevisions(initialMessages, pending);
    this.currentTurnStartIndexValue = applyLiveChatContextRevisions(initialMessages.slice(0, 1 + options.historyMessages.length), pending).length;
    this.recorder?.recordContextInitialized(ChatContextInitSchema.parse({
      ...(options.initialQueueMessageIds ? { queueMessageIds: options.initialQueueMessageIds } : {}),
      messages: this.messages,
      contextRevision: 0,
      turnBoundary: this.currentTurnStartIndexValue,
    }));
    this.appliedHistoryRevision = revisions.length;
  }

  get length(): number {
    return this.messages.length;
  }

  getMessages(): readonly ChatMessage[] {
    return this.messages;
  }

  render(includeReasoningContent: boolean): string {
    return renderTaskTranscript(this.messages, { includeReasoningContent });
  }

  takeNewMessagesForLogging(): ChatMessage[] {
    const fresh = this.messages.slice(this.lastLoggedMessageCount);
    this.lastLoggedMessageCount = this.messages.length;
    return fresh;
  }

  replaceWith(compactedMessages: readonly ChatMessage[], currentTurnStartIndex: number | null): void {
    if (currentTurnStartIndex !== null
      && (!Number.isInteger(currentTurnStartIndex)
        || currentTurnStartIndex < 0
        || currentTurnStartIndex >= compactedMessages.length)) {
      throw new Error(
        `TranscriptManager: invalid current turn start index ${String(currentTurnStartIndex)} for a ${compactedMessages.length}-message replacement`,
      );
    }
    const replacement = compactedMessages.map(message => this.recorder !== null
      && message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith(COMPACTION_SUMMARY_MARKER)
      ? { ...message, chatMessageId: buildChatMessageId(this.recorder.messageIdPrefix, { kind: 'summary', revision: this.contextRevisionValue + 1 }) } : message);
    const retainedIds = new Set(replacement.flatMap(chatDisplayMessageIds));
    const compressedMessageIds = this.messages.flatMap(chatDisplayMessageIds).filter(id => !retainedIds.has(id));
    // No retained turn (manual compaction): the sentinel sits past the end, so any later
    // chat-boundary read sees an out-of-range index instead of a borrowed live turn.
    this.applySplice(
      0,
      this.messages.length,
      replacement,
      'compacted',
      currentTurnStartIndex ?? compactedMessages.length,
      { compressedMessageIds },
    );
    this.lastLoggedMessageCount = 0;
    // Compaction rebuilds the array, so any index an earlier turn remembered is meaningless.
    this.forcedFinishCountdownIndex = -1;
    this.releaseDroppedImageGuards();
  }

  appendToolExchange(action: ToolTranscriptAction, toolCallId: string, toolContent: string, thinkingText: string): void {
    this.append(buildToolExchangeMessages(action, toolCallId, toolContent, thinkingText));
  }

  /** Appends the batch and returns the index its assistant message landed at. */
  appendBatchExchange(outcomes: readonly ToolBatchOutcome[], thinkingText: string, content = ''): number {
    const preAppendLength = this.messages.length;
    this.append(buildToolBatchMessages(outcomes, thinkingText, content));
    return preAppendLength;
  }

  pushAssistant(message: ChatMessage): void {
    this.append([message]);
  }

  pushUser(content: string, images: readonly string[] = [], imagePathKey?: string): void {
    this.append([buildUserMessage(content, images, imagePathKey)]);
  }

  pushQueuedUser(id: string, content: string, images: readonly string[]): void {
    this.applySplice(this.messages.length, 0, [{ ...buildUserMessage(content, images), chatMessageId: id }], 'append', this.currentTurnStartIndexValue, { queueMessageIds: [id] });
  }

  insertUserAfter(index: number, content: string, images: readonly string[], imagePathKey: string, toolCallId: string): void {
    const messageId = this.recorder?.resolveToolMessageId(toolCallId);
    if (messageId === null) throw new Error('A recorded tool image requires its display identity.');
    this.applySplice(
      index + 1,
      0,
      [{ ...buildUserMessage(content, images, imagePathKey), ...(messageId === undefined ? {} : { chatMessageId: messageId }) }],
      'insert',
      this.currentTurnStartIndexValue,
    );
  }

  hasToolResult(toolCallId: string): boolean {
    return this.findToolResultIndex(toolCallId) >= 0;
  }

  /**
   * Rewrites the result of an already-answered call. Anchored by call id rather than by index,
   * because the image messages inserted after a batch shift every index it was appended at.
   */
  replaceToolResult(toolCallId: string, content: string): void {
    const index = this.findToolResultIndex(toolCallId);
    if (index < 0) {
      throw new Error(`TranscriptManager: no tool result for call ${toolCallId} to replace`);
    }
    this.applySplice(
      index,
      1,
      [{ ...this.messages[index], content }],
      'tool_result_replaced',
      this.currentTurnStartIndexValue,
    );
  }

  private findToolResultIndex(toolCallId: string): number {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message.role === 'tool' && message.tool_call_id === toolCallId) return index;
    }
    return -1;
  }

  /** The single trailing countdown message, rewritten in place while it is still the last one. */
  upsertForcedFinishCountdown(content: string): void {
    const slot = resolveTrailingUserSlot(this.messages.length, this.forcedFinishCountdownIndex);
    this.applySplice(
      slot.index,
      slot.deleteCount,
      [{ role: 'user', content }],
      'trailing_user_replaced',
      this.currentTurnStartIndexValue,
    );
    this.forcedFinishCountdownIndex = slot.index;
  }

  pruneThinking(maintainPerStepThinking: boolean): void {
    const pruned = new ThinkingRetentionPolicy(maintainPerStepThinking).prunePlannerMessages(this.messages);
    if (pruned === this.messages) return;
    this.applySplice(0, this.messages.length, pruned, 'thinking_pruned', this.currentTurnStartIndexValue);
  }

  /** Ages images out of the retention window and releases the re-read guards they held. */
  pruneImages(retention: number): void {
    this.reconcileHistory();
    const outcome = new ImageRetentionPolicy(retention).prune(this.messages);
    if (outcome.messages === this.messages) return;
    this.applySplice(0, this.messages.length, outcome.messages, 'images_pruned', this.currentTurnStartIndexValue);
    for (const droppedPathKey of outcome.droppedPathKeys) {
      this.liveImagePathKeys.delete(droppedPathKey);
    }
  }

  reconcileHistory(): void {
    const revisions = this.recorder?.readHistoryRevisions() ?? [];
    const pending = revisions.slice(this.appliedHistoryRevision);
    if (pending.length === 0) return;
    const messages = applyLiveChatContextRevisions(this.messages, pending);
    const boundary = applyLiveChatContextRevisions(this.messages.slice(0, this.currentTurnStartIndexValue), pending).length;
    this.applySplice(0, this.messages.length, messages, 'history_revised', boundary);
    this.appliedHistoryRevision = revisions.length;
    this.releaseDroppedImageGuards();
  }

  private append(inserted: readonly ChatMessage[]): void {
    if (inserted.length === 0) return;
    this.applySplice(this.messages.length, 0, inserted, 'append', this.currentTurnStartIndexValue);
  }

  /**
   * The one path that changes history: validate the splice, hand it to the recorder, then apply it.
   * Recording first is what makes an interrupted run replayable — a mutation the recorder refused
   * never reaches the array the model reads.
   */
  private applySplice(
    startIndex: number,
    deleteCount: number,
    inserted: readonly ChatMessage[],
    reason: ChatContextSpliceReason,
    turnBoundary: number,
    metadata?: Pick<ChatContextSplice, 'queueMessageIds' | 'compressedMessageIds'>,
  ): void {
    const splice = ChatContextSpliceSchema.parse({
      ...metadata,
      expectedRevision: this.contextRevisionValue,
      contextRevision: this.contextRevisionValue + 1,
      startIndex,
      deleteCount,
      inserted: inserted.map(message => {
        if (this.recorder === null) return message;
        if (reason === 'append' && message.role === 'tool' && message.tool_call_id !== undefined && message.chatMessageId === undefined) {
          const id = this.recorder.resolveToolMessageId(message.tool_call_id);
          if (id === null) throw new Error('A recorded tool result requires its display identity.');
          return { ...message, chatMessageId: id };
        }
        if (reason !== 'append' || message.role !== 'assistant') return message;
        const metadata = { messageIdPrefix: this.recorder.messageIdPrefix };
        const messageId = this.recorder.resolveAssistantMessageId(this.modelTurn);
        return { ...message,
          chatMessageId: message.chatMessageId ?? messageId,
          thinkingMessageId: message.thinkingMessageId ?? buildChatMessageId(metadata.messageIdPrefix, { kind: 'thinking', turn: this.modelTurn }),
        };
      }),
      turnBoundary,
      reason,
    });
    this.recorder?.recordContextSpliced(splice);
    this.messages.splice(splice.startIndex, splice.deleteCount, ...splice.inserted);
    this.contextRevisionValue = splice.contextRevision;
    this.currentTurnStartIndexValue = splice.turnBoundary;
  }

  /**
   * Compaction that drops an image message must release its re-read guard, or the model is
   * stranded referring to an image it can no longer see and cannot re-read.
   */
  private releaseDroppedImageGuards(): void {
    const survivingPathKeys = new Set<string>();
    for (const message of this.messages) {
      if (!Array.isArray(message.content)) continue;
      if (countContentImages(message.content) === 0) continue;
      if (message.imagePathKey !== undefined) survivingPathKeys.add(message.imagePathKey);
    }
    for (const pathKey of [...this.liveImagePathKeys]) {
      if (!survivingPathKeys.has(pathKey)) this.liveImagePathKeys.delete(pathKey);
    }
  }
}

function chatDisplayMessageIds(message: ChatMessage): string[] {
  return [message.chatMessageId, message.thinkingMessageId].filter((id): id is string => id !== undefined);
}

function buildUserMessage(content: string, images: readonly string[], imagePathKey?: string): ChatMessage {
  return {
    role: 'user',
    content: buildUserContent(content, images),
    ...(imagePathKey === undefined ? {} : { imagePathKey }),
  };
}
