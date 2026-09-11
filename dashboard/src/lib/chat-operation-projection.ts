import type { ChatOperationSnapshot, ChatOperationUpdate } from '@siftkit/contracts';

/** Owns one stream's committed display view. Incomplete pages never replace readable state. */
export class ChatOperationProjection {
  snapshot: ChatOperationSnapshot | null = null;
  private pending: ChatOperationSnapshot | null = null;

  constructor(private readonly sessionId: string) {}

  acceptSnapshotPage(page: ChatOperationSnapshot): ChatOperationSnapshot | null {
    this.requireIdentity(page);
    if (page.messageOffset === 0) this.pending = null;
    const previous = this.pending;
    if (page.messageOffset !== (previous?.messages.length ?? 0)) throw new Error('Chat snapshot page offset gap.');
    if (previous && (previous.cursor.sequence !== page.cursor.sequence || previous.operationId !== page.operationId)) {
      throw new Error('Chat snapshot page cursor mismatch.');
    }
    const messages = [...(previous?.messages ?? []), ...page.messages];
    if (new Set(messages.map(message => message.id)).size !== messages.length) throw new Error('Chat snapshot contains duplicate message IDs.');
    const assembled = { ...page, messageOffset: 0, messages, tools: [...(previous?.tools ?? []), ...page.tools] };
    if (!page.complete) {
      this.pending = assembled;
      return null;
    }
    this.pending = null;
    if (this.snapshot && page.cursor.sequence < this.snapshot.cursor.sequence) return null;
    this.snapshot = assembled;
    return assembled;
  }

  acceptUpdate(update: ChatOperationUpdate): ChatOperationSnapshot | null {
    this.requireIdentity(update);
    const { afterSequence, messageOrder, ...view } = update;
    const previous = this.snapshot;
    if (!previous || this.pending) throw new Error('Chat update arrived before a complete snapshot.');
    if (update.cursor.sequence <= previous.cursor.sequence && afterSequence < previous.cursor.sequence) return null;
    if (afterSequence !== previous.cursor.sequence || update.cursor.sequence < afterSequence) throw new Error('Chat update cursor gap.');
    const order = new Set(messageOrder);
    if (order.size !== messageOrder.length || new Set(update.messages.map(message => message.id)).size !== update.messages.length) {
      throw new Error('Chat update contains duplicate message IDs.');
    }
    const rows = new Map(previous.messages.map(message => [message.id, message]));
    for (const message of update.messages) {
      if (!order.has(message.id)) throw new Error('Chat update row is missing from its order.');
      rows.set(message.id, message);
    }
    const messages = messageOrder.map(id => {
      const message = rows.get(id);
      if (!message) throw new Error('Chat update is missing a message body.');
      return message;
    });
    this.snapshot = { ...view, messages, messageOffset: 0, complete: true };
    return this.snapshot;
  }

  private requireIdentity(view: Pick<ChatOperationSnapshot, 'sessionId' | 'operationId' | 'cursor'>): void {
    if (view.sessionId !== this.sessionId) throw new Error('Chat snapshot session mismatch.');
    if (view.operationId !== view.cursor.operationId || this.snapshot && view.operationId !== this.snapshot.operationId) {
      throw new Error('Chat snapshot operation mismatch.');
    }
  }
}
