import { renderTaskTranscript, type ChatMessage } from '../planner-protocol.js';
import {
  appendToolCallExchange,
  appendToolBatchExchange,
  upsertTrailingUserMessage,
  type ToolBatchOutcome,
  type ToolTranscriptAction,
} from '../../tool-call-messages.js';
import { ThinkingRetentionPolicy } from '../../thinking-retention-policy.js';
import { buildUserContent, countContentImages } from '../../llm-protocol/image-attachments.js';

export class TranscriptManager {
  private readonly messages: ChatMessage[];
  private readonly liveImagePathKeys: Set<string>;
  private lastLoggedMessageCount = 0;
  private generationCounter = 0;
  private currentTurnStartIndexValue: number;

  /** Incremented whenever compaction rewrites the message array, invalidating absolute indexes. */
  get generation(): number {
    return this.generationCounter;
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
    historyMessages: ChatMessage[];
    initialUserContent: string;
    initialUserImages: readonly string[];
    liveImagePathKeys: Set<string>;
  }) {
    this.liveImagePathKeys = options.liveImagePathKeys;
    this.messages = [
      { role: 'system', content: options.systemPromptContent },
      ...options.historyMessages,
      { role: 'user', content: buildUserContent(options.initialUserContent, options.initialUserImages) },
    ];
    this.currentTurnStartIndexValue = 1 + options.historyMessages.length;
  }

  get length(): number {
    return this.messages.length;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  messageRoles(): string[] {
    return this.messages.map((message) => String(message.role || 'unknown'));
  }

  render(includeReasoningContent: boolean): string {
    return renderTaskTranscript(this.messages, { includeReasoningContent });
  }

  renderTail(skipCount: number): string {
    return renderTaskTranscript(this.messages.slice(skipCount), { includeReasoningContent: false });
  }

  replaceWith(compactedMessages: ChatMessage[], currentTurnStartIndex: number | null): void {
    if (currentTurnStartIndex !== null
      && (!Number.isInteger(currentTurnStartIndex)
        || currentTurnStartIndex < 0
        || currentTurnStartIndex >= compactedMessages.length)) {
      throw new Error(
        `TranscriptManager: invalid current turn start index ${String(currentTurnStartIndex)} for a ${compactedMessages.length}-message replacement`,
      );
    }
    this.messages.splice(0, this.messages.length, ...compactedMessages);
    // No retained turn (manual compaction): the sentinel sits past the end, so any later
    // chat-boundary read sees an out-of-range index instead of a borrowed live turn.
    this.currentTurnStartIndexValue = currentTurnStartIndex ?? compactedMessages.length;
    this.lastLoggedMessageCount = 0;
    this.generationCounter += 1;
    this.releaseDroppedImageGuards();
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

  takeNewMessagesForLogging(): ChatMessage[] {
    const fresh = this.messages.slice(this.lastLoggedMessageCount);
    this.lastLoggedMessageCount = this.messages.length;
    return fresh;
  }

  appendToolExchange(action: ToolTranscriptAction, toolCallId: string, toolContent: string, thinkingText: string): void {
    appendToolCallExchange(this.messages, action, toolCallId, toolContent, thinkingText);
  }

  appendBatchExchange(outcomes: ToolBatchOutcome[], thinkingText: string): number {
    const preAppendLength = this.messages.length;
    appendToolBatchExchange(this.messages, outcomes, thinkingText);
    return preAppendLength;
  }

  pushAssistant(message: ChatMessage): void {
    this.messages.push(message);
  }

  pruneThinking(maintainPerStepThinking: boolean): void {
    new ThinkingRetentionPolicy(maintainPerStepThinking).prunePlannerMessages(this.messages);
  }

  pushUser(content: string, images: readonly string[] = [], imagePathKey?: string): void {
    this.messages.push({
      role: 'user',
      content: buildUserContent(content, images),
      ...(imagePathKey === undefined ? {} : { imagePathKey }),
    });
  }

  insertUserAfter(index: number, content: string, images: readonly string[], imagePathKey?: string): void {
    this.messages.splice(index + 1, 0, {
      role: 'user',
      content: buildUserContent(content, images),
      ...(imagePathKey === undefined ? {} : { imagePathKey }),
    });
  }

  replaceToolMessage(index: number, content: string): void {
    const previousToolMessage = this.messages[index];
    this.messages[index] = {
      role: 'tool',
      tool_call_id: previousToolMessage?.tool_call_id,
      content,
    };
  }

  upsertTrailingUser(previousIndex: number, content: string): number {
    return upsertTrailingUserMessage(this.messages, previousIndex, content);
  }
}
