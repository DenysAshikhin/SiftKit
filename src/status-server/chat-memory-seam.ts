import type { AssistantRuntime } from '../assistant/assistant-service.js';
import type { SiftPreset } from '@siftkit/contracts';

export interface ChatTurnRecord {
  readonly sessionId: string;
  readonly capturedAtUtc: string;
  readonly userMessageId: string;
  readonly userText: string;
  readonly assistantMessageId: string;
  readonly assistantText: string;
}

type AssistantMemoryService = Pick<
  AssistantRuntime,
  'ownerId' | 'retrieveMemoryContext' | 'ingestChatTurn'
>;

/**
 * The whole Â§11.1 gate in one place: memory is read and written only when the assistant started
 * and the session's preset opted in. Both directions fail soft â€” a broken assistant must never
 * break a chat turn.
 */
export class ChatMemorySeam {
  constructor(private readonly assistant: AssistantMemoryService | null) {}

  async buildMemoryContext(preset: SiftPreset, userMessage: string): Promise<string> {
    const assistant = this.assistant;
    if (assistant === null || preset.assistantMemory !== true) {
      return '';
    }
    try {
      return (await assistant.retrieveMemoryContext(userMessage)).renderedBlock;
    } catch {
      return '';
    }
  }

  ingestTurn(preset: SiftPreset, turn: ChatTurnRecord): void {
    const assistant = this.assistant;
    if (assistant === null || preset.assistantMemory !== true) {
      return;
    }
    assistant.ingestChatTurn({
      ownerId: assistant.ownerId,
      sessionId: turn.sessionId,
      capturedAtUtc: turn.capturedAtUtc,
      userMessageId: turn.userMessageId,
      userText: turn.userText,
      assistantMessageId: turn.assistantMessageId,
      assistantText: turn.assistantText,
    });
  }
}
