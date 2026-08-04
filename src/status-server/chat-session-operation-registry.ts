import { randomUUID } from 'node:crypto';

import type { ChatSessionOperationKind } from '@siftkit/contracts';

export type ChatSessionOperation = {
  token: string;
  sessionId: string;
  operationKind: ChatSessionOperationKind;
  startedAtMs: number;
};

export type ChatSessionOperationAcquireResult =
  | { kind: 'acquired'; lease: ChatSessionOperation }
  | { kind: 'conflict'; active: ChatSessionOperation };

function requireSessionId(sessionId: string): void {
  if (!sessionId.trim()) {
    throw new Error('Chat session ID is required.');
  }
}

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
      return { kind: 'conflict', active };
    }
    const lease: ChatSessionOperation = {
      token: randomUUID(),
      sessionId,
      operationKind,
      startedAtMs: nowMs,
    };
    this.activeBySessionId.set(sessionId, lease);
    return { kind: 'acquired', lease };
  }

  release(lease: ChatSessionOperation): boolean {
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
}
