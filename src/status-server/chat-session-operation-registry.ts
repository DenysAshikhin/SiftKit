/* c8 ignore next */
import { randomUUID } from 'node:crypto';

/* c8 ignore next */
import type { ChatSessionOperationKind } from '@siftkit/contracts';

function requireSessionId(sessionId: string): void {
  if (!sessionId.trim()) {
    throw new Error('Chat session ID is required.');
  }
}

function createChatSessionOperation(
  sessionId: string,
  operationKind: ChatSessionOperationKind,
  startedAtMs: number,
) {
  return { token: randomUUID(), sessionId, operationKind, startedAtMs };
}

function createAcquiredResult(lease: ChatSessionOperation) {
  return { kind: 'acquired' as const, lease };
}

function createConflictResult(active: ChatSessionOperation) {
  return { kind: 'conflict' as const, active };
}

export type ChatSessionOperation = ReturnType<typeof createChatSessionOperation>;
export type ChatSessionOperationLease = ChatSessionOperation;
export type ChatSessionOperationAcquireResult =
  | ReturnType<typeof createAcquiredResult>
  | ReturnType<typeof createConflictResult>;

export class ChatSessionOperationRegistry {
  private readonly activeBySessionId = new Map<string, ChatSessionOperation>();

  acquire(
    sessionId: string,
    operationKind: ChatSessionOperationKind,
    nowMs: number,
  ): ChatSessionOperationAcquireResult {
    requireSessionId(sessionId);
    const active = this.activeBySessionId.get(sessionId) ?? null;
    if (active !== null) {
      return createConflictResult(active);
    }
    const lease = createChatSessionOperation(sessionId, operationKind, nowMs);
    this.activeBySessionId.set(sessionId, lease);
    return createAcquiredResult(lease);
  }

  release(lease: ChatSessionOperationLease): boolean {
    const active = this.activeBySessionId.get(lease.sessionId) ?? null;
    if (active === null || active.token !== lease.token) {
      return false;
    }
    this.activeBySessionId.delete(lease.sessionId);
    return true;
  }

  getActiveOperation(sessionId: string): ChatSessionOperation | null {
    requireSessionId(sessionId);
    return this.activeBySessionId.get(sessionId) ?? null;
  }

  getActiveCount(): number {
    return this.activeBySessionId.size;
  }
  /* c8 ignore next */
}
