import { ChatSessionRuntimeStore, type ChatSessionRuntimeTransition } from './chat-session-runtime-store';

/** The one mutable holder of chat runtime state; React reads it through useChatRuntimeSelector, never as component state. */
export class ChatRuntimeHub {
  private store: ChatSessionRuntimeStore;
  private readonly listeners = new Set<() => void>();

  constructor(store: ChatSessionRuntimeStore = new ChatSessionRuntimeStore()) {
    this.store = store;
  }

  // Arrow properties: useSyncExternalStore needs stable function identities.
  getStore = (): ChatSessionRuntimeStore => this.store;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Applies the transitions in order; subscribers hear once, and only when something changed. */
  apply(...transitions: ChatSessionRuntimeTransition[]): void {
    this.replace(transitions.reduce((store, transition) => store.apply(transition), this.store));
  }

  ensureSession(sessionId: string, planRepoRootInput: string): void {
    this.replace(this.store.ensureSession(sessionId, planRepoRootInput));
  }

  removeSession(sessionId: string): void {
    this.replace(this.store.removeSession(sessionId));
  }

  private replace(next: ChatSessionRuntimeStore): void {
    if (next === this.store) return;
    this.store = next;
    for (const listener of this.listeners) listener();
  }
}
