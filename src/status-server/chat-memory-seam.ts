import type { AssistantRuntime } from '../assistant/assistant-service.ts';
import type { SiftPreset } from '@siftkit/contracts';
import type { VaultChatTurn } from '../vault/note-writer/chat-writer.ts';

type AssistantMemoryService = Pick<AssistantRuntime, 'enabled' | 'retrieveMemoryContext' | 'ingestChatTurn'>;

/**
 * The whole §11.1 gate in one place: memory is read and written only when the assistant started
 * and the session's preset opted in. Both directions fail soft — a broken assistant must never
 * break a chat turn.
 */
export class ChatMemorySeam {
  private readonly assistant: AssistantMemoryService | null;

  constructor(assistant: AssistantMemoryService | null) {
    this.assistant = assistant;
  }

  async buildMemoryContext(preset: SiftPreset, userMessage: string): Promise<string> {
    const assistant = this.assistant;
    if (assistant === null || !assistant.enabled || preset.assistantMemory !== true) {
      return '';
    }
    try {
      return (await assistant.retrieveMemoryContext(userMessage)).renderedBlock;
    } catch {
      return '';
    }
  }

  ingestTurn(preset: SiftPreset, turn: VaultChatTurn): void {
    const assistant = this.assistant;
    if (assistant === null || !assistant.enabled || preset.assistantMemory !== true) {
      return;
    }
    assistant.ingestChatTurn(turn);
  }
}
