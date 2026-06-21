import { renderTaskTranscript, type ChatMessage } from '../planner-protocol.js';
import {
  appendToolCallExchange,
  appendToolBatchExchange,
  upsertTrailingUserMessage,
  type ToolBatchOutcome,
  type ToolTranscriptAction,
} from '../../tool-call-messages.js';
import { ThinkingRetentionPolicy } from '../../thinking-retention-policy.js';

export class TranscriptManager {
  private readonly messages: ChatMessage[];
  private lastLoggedMessageCount = 0;

  constructor(options: {
    systemPromptContent: string;
    historyMessages: ChatMessage[];
    initialUserContent: string;
  }) {
    this.messages = [
      { role: 'system', content: options.systemPromptContent },
      ...options.historyMessages,
      { role: 'user', content: options.initialUserContent },
    ];
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

  render(): string {
    return renderTaskTranscript(this.messages);
  }

  renderTail(skipCount: number): string {
    return renderTaskTranscript(this.messages.slice(skipCount));
  }

  replaceWith(compactedMessages: ChatMessage[]): void {
    this.messages.splice(0, this.messages.length, ...compactedMessages);
    this.lastLoggedMessageCount = 0;
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

  pushUser(content: string): void {
    this.messages.push({ role: 'user', content });
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
