import type { ChatOperationFrame, ChatOperationSubscriber } from './chat-operation-broadcast.js';
import type { SseResponseWriter } from './sse-response-writer.js';

/** Mirrors one operation's broadcast frames onto one SSE response and closes it with the run. */
export class ChatOperationSseSubscriber implements ChatOperationSubscriber {
  constructor(private readonly writer: SseResponseWriter) {}

  onFrame(frame: ChatOperationFrame): void {
    this.writer.writeSerializedEvent(frame.event, frame.data);
  }

  onClosed(): void {
    this.writer.end();
  }
}
