/** Why a closed operation stream ended: cleanly, or with the first failure its owner reported. */
export type ChatOperationClosure = { failure: string | null };

export interface ChatOperationSubscriber {
  /** Something committed to the journal or live state; re-read it. The notice carries no payload. */
  onPublished(): void;
  /** The session's history changed outside the run (edit, deletion, purge); re-read the journal. */
  onHistoryRevised(): void;
  onClosed(closure: ChatOperationClosure): void;
}

/** Wakes subscribers after committed publications. The journal owns replay and transcript data. */
export class ChatOperationBroadcast {
  private readonly subscribers = new Set<ChatOperationSubscriber>();
  private closed = false;
  private failure: string | null = null;

  publish(): void {
    if (this.closed) return;
    for (const subscriber of this.subscribers) subscriber.onPublished();
  }

  /** Records the first failure for the closing notice; later failures keep the original cause. */
  fail(error: string): void {
    if (this.closed) return;
    this.failure ??= error;
    this.publish();
  }

  /** Wakes readers after a committed history revision; there is no frame because nothing streamed. */
  notifyHistoryRevised(): void {
    if (this.closed) return;
    for (const subscriber of this.subscribers) subscriber.onHistoryRevised();
  }

  /** Subscribe before capturing a journal snapshot, so concurrent publications trigger catch-up. */
  attach(subscriber: ChatOperationSubscriber): void {
    if (this.closed) {
      subscriber.onClosed({ failure: this.failure });
      return;
    }
    this.subscribers.add(subscriber);
  }

  detach(subscriber: ChatOperationSubscriber): void {
    this.subscribers.delete(subscriber);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) subscriber.onClosed({ failure: this.failure });
  }

  isClosed(): boolean {
    return this.closed;
  }

  hasFailed(): boolean {
    return this.failure !== null;
  }
}
