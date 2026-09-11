import { randomUUID } from 'node:crypto';

import type { ChatSessionOperationKind } from '@siftkit/contracts';

import { ChatOperationBroadcast } from './chat-operation-broadcast.js';
import type { ChatRunRecorder } from './chat-run-recorder.js';

export type ChatSessionOperation = {
  token: string;
  sessionId: string;
  operationKind: ChatSessionOperationKind;
  operationId: string;
  startedAtMs: number;
  abort?: () => void;
  failure?: string;
  stopRequested?: boolean;
  recorder?: ChatRunRecorder;
};

export type ChatSessionOperationAcquireResult =
  | { kind: 'acquired'; lease: ChatSessionOperation }
  | { kind: 'conflict'; active: ChatSessionOperation };

export type ChatSessionOperationCompletion =
  | { kind: 'completed' }
  | { kind: 'failed'; error: string };

class ActiveChatSessionOperation {
  readonly completion: Promise<ChatSessionOperationCompletion>;
  readonly broadcast = new ChatOperationBroadcast();
  private settleCompletion: ((completion: ChatSessionOperationCompletion) => void) | null = null;

  constructor(readonly lease: ChatSessionOperation) {
    this.completion = new Promise((resolve) => { this.settleCompletion = resolve; });
  }

  finish(completion: ChatSessionOperationCompletion): void {
    const settleCompletion = this.settleCompletion;
    if (!settleCompletion) return;
    this.settleCompletion = null;
    settleCompletion(completion);
  }
}

function requireSessionId(sessionId: string): void {
  if (!sessionId.trim()) {
    throw new Error('Chat session ID is required.');
  }
}

export class ChatSessionOperationRegistry {
  private readonly activeBySessionId = new Map<string, ActiveChatSessionOperation>();
  private readonly latestCompletion = new Map<string, { operationId: string; completion: ChatSessionOperationCompletion }>();

  getCompletion(sessionId: string, operationId: string): ChatSessionOperationCompletion | null {
    const last = this.latestCompletion.get(sessionId);
    return last?.operationId === operationId ? last.completion : null;
  }

  acquire(
    sessionId: string,
    operationKind: ChatSessionOperationKind,
    operationId: string,
    nowMs: number,
  ): ChatSessionOperationAcquireResult {
    requireSessionId(sessionId);
    const active = this.activeBySessionId.get(sessionId) ?? null;
    if (active !== null) {
      return { kind: 'conflict', active: active.lease };
    }
    const lease: ChatSessionOperation = {
      token: randomUUID(),
      sessionId,
      operationKind,
      operationId,
      startedAtMs: nowMs,
    };
    this.activeBySessionId.set(sessionId, new ActiveChatSessionOperation(lease));
    return { kind: 'acquired', lease };
  }

  finish(lease: ChatSessionOperation, completion: ChatSessionOperationCompletion): boolean {
    const active = this.activeBySessionId.get(lease.sessionId) ?? null;
    if (active === null || active.lease.token !== lease.token) {
      return false;
    }
    const error = lease.failure;
    if (error) completion = { kind: 'failed', error };
    this.latestCompletion.set(lease.sessionId, { operationId: lease.operationId, completion });
    delete lease.abort;
    this.activeBySessionId.delete(lease.sessionId);
    // Closing carries the failure, so an attached reader can always tell "the run failed" from
    // "the run finished" from "the socket dropped".
    if (completion.kind === 'failed') active.broadcast.fail(completion.error);
    active.broadcast.close();
    active.finish(completion);
    return true;
  }

  waitForCompletion(lease: ChatSessionOperation): Promise<ChatSessionOperationCompletion> {
    const active = this.activeBySessionId.get(lease.sessionId) ?? null;
    if (active === null || active.lease.token !== lease.token) {
      return Promise.reject(new Error('Lease is not the active chat operation.'));
    }
    return active.completion;
  }

  getActiveOperation(sessionId: string): ChatSessionOperation | null {
    requireSessionId(sessionId);
    return this.activeBySessionId.get(sessionId)?.lease ?? null;
  }

  registerAbort(lease: ChatSessionOperation, abort: () => void): boolean {
    const active = this.activeBySessionId.get(lease.sessionId);
    if (!active || active.lease.token !== lease.token) {
      return false;
    }
    active.lease.abort = abort;
    return true;
  }

  getActive(sessionId: string): ChatSessionOperation | undefined {
    requireSessionId(sessionId);
    return this.activeBySessionId.get(sessionId)?.lease;
  }

  getBroadcast(sessionId: string): ChatOperationBroadcast | null {
    requireSessionId(sessionId);
    return this.activeBySessionId.get(sessionId)?.broadcast ?? null;
  }

  listActive(): ChatSessionOperation[] {
    return [...this.activeBySessionId.values()].map((active) => active.lease);
  }

  getActiveCount(): number {
    return this.activeBySessionId.size;
  }
}
