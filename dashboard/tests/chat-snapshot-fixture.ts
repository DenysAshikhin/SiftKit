import { ChatOperationSnapshotSchema, type ChatOperationSnapshot } from '@siftkit/contracts';

export function chatSnapshot(overrides: Partial<ChatOperationSnapshot> = {}): ChatOperationSnapshot {
  const operationId = overrides.operationId ?? '4f9c1f9a-0000-4000-8000-000000000000';
  return ChatOperationSnapshotSchema.parse({ sessionId: 's1', operationId, runOrder: 1, controlOperationId: operationId,
    operationKind: 'repo-agent', recordKind: 'execution', startedAtUtc: '2026-09-08T12:00:00.000Z', terminalCause: null,
    status: 'ok', cursor: { operationId, sequence: 1 }, messageOffset: 0, messages: [], tools: [], approval: null,
    tokenTurns: [], streamedCharsSinceBase: 0, warnings: [], issues: [], complete: true, ...overrides });
}

export function chatSnapshotFrame(overrides: Partial<ChatOperationSnapshot> = {}): string {
  return `event: snapshot\ndata: ${JSON.stringify(chatSnapshot(overrides))}\n\n`;
}
