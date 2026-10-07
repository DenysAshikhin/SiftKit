import { useSyncExternalStore } from 'react';
import type { ChatRuntimeHub } from '../lib/chat-runtime-hub.ts';
import type { ChatSessionRuntimeStore } from '../lib/chat-session-runtime-store.ts';

/**
 * One slice of the chat runtime; the component re-renders only when the slice changes identity. `select`
 * must return a store-owned value or a primitive, never a fresh object, or every store change re-renders.
 */
export function useChatRuntimeSelector<T>(hub: ChatRuntimeHub, select: (store: ChatSessionRuntimeStore) => T): T {
  const getSnapshot = (): T => select(hub.getStore());
  return useSyncExternalStore(hub.subscribe, getSnapshot, getSnapshot);
}
