import { randomUUID } from 'node:crypto';

import type { ChatSessionOperationKind } from '@siftkit/contracts';

export type ChatSessionOperation = {
  token: string;
  sessionId: string;
  operationKind: ChatSessionOperationKind;
  startedAtMs: number;
  abort?: () => void;
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

  registerAbort(lease: ChatSessionOperation, abort: () => void): boolean {
    const active = this.activeBySessionId.get(lease.sessionId);
    if (!active || active.token !== lease.token) {
      return false;
    }
    active.abort = abort;
    return true;
  }

  getActive(sessionId: string): ChatSessionOperation | undefined {
    requireSessionId(sessionId);
    return this.activeBySessionId.get(sessionId);
  }

  getActiveCount(): number {
    return this.activeBySessionId.size;
  }
}
