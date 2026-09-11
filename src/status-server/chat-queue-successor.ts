import { toError } from '../lib/errors.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { DEFAULT_APPROVAL_MODE, type ChatMessageQueueForceState } from '@siftkit/contracts';
import { MockPlannerResponsesSchema } from '../planner-protocol/mock-response.js';
import { RepoSearchMockCommandResultSchema } from '../repo-search/types.js';
import { z } from '../lib/zod.js';
import { getChatSessionPath, readChatSessionFromPath } from '../state/chat-sessions.js';
import type { ChatQueuedMessage } from '../state/chat-message-queue.js';
import { getRuntimeRoot } from './paths.js';
import type { ServerContext } from './server-types.js';
import type { ChatSessionOperation } from './chat-session-operation-registry.js';
import { StreamChatMessageEndpoint, StreamChatRepoOperationEndpoint, admitSelectedChatImages } from './routes/chat.js';
import { readConfig } from './config-store.js';
import { StreamChatRepoAgentEndpoint } from './routes/chat-repo-agent.js';
import { awaitRepoSearchRunPersistence } from '../repo-search/execute.js';

/** Owns continuation leases; each mode reuses its existing complete execution path. */
export class ChatQueueSuccessorRunner {
  constructor(private readonly ctx: ServerContext) {}

  async startPending(sessionId: string): Promise<void> {
    const state = this.ctx.chatMessageQueue.store.state(sessionId);
    if (state.paused || state.force || this.ctx.chatSessionOperations.getActive(sessionId)
      || !state.messages.some((message) => message.state === 'pending')) return;
    const intent = this.ctx.chatMessageQueue.store.beginForce(sessionId, { id: randomUUID(), operationId: null }, randomUUID());
    if (intent.kind !== 'started') return;
    try { await this.start(sessionId, intent.force); }
    catch (error) { this.fail(sessionId, intent.force, toError(error).message); }
  }

  private fail(sessionId: string, force: ChatMessageQueueForceState, error: string): void {
    this.ctx.chatMessageQueue.store.failForce(sessionId, force, error);
    this.ctx.chatMessageQueue.publish(sessionId);
  }

  async start(sessionId: string, force: ChatMessageQueueForceState): Promise<ChatSessionOperation> {
    const current = this.ctx.chatMessageQueue.store.state(sessionId).force;
    if (!current || current.id !== force.id || current.phase === 'failed') throw new Error('Queued continuation was cancelled.');
    const ids = new Set(force.messageIds);
    const queuedMessages = this.ctx.chatMessageQueue.store.listPending(sessionId).filter((message) => ids.has(message.id));
    const first = queuedMessages[0];
    if (!first || queuedMessages.length !== ids.size) throw new Error('Queued continuation snapshot is unavailable.');
    if (queuedMessages.some((message) => message.options.operationKind !== first.options.operationKind)) throw new Error('Conflicting queued operation modes.');
    const sessionPath = getChatSessionPath(getRuntimeRoot(), sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) throw new Error('Chat session not found.');
    const config = readConfig(this.ctx.configPath);
    for (const message of queuedMessages) admitSelectedChatImages(config, session, message.images);
    const acquired = this.ctx.chatSessionOperations.acquire(sessionId, first.options.operationKind, force.successorOperationId, Date.now());
    if (acquired.kind !== 'acquired') throw new Error('Chat session has a competing operation.');
    const lease = acquired.lease;
    this.ctx.chatMessageQueue.publish(sessionId);
    void this.execute(lease, force, queuedMessages).catch((error) => {
      const message = toError(error).message;
      this.ctx.chatSessionOperations.finish(lease, { kind: 'failed', error: message });
      this.fail(sessionId, force, message);
    });
    return lease;
  }

  private async execute(lease: ChatSessionOperation, force: ChatMessageQueueForceState, queuedMessages: ChatQueuedMessage[]): Promise<void> {
    const sessionId = lease.sessionId;
    const sessionPath = getChatSessionPath(getRuntimeRoot(), sessionId);
    const session = readChatSessionFromPath(sessionPath);
    const first = queuedMessages[0];
    if (!session || !first) throw new Error('Queued session or first message is missing.');
    const { operationKind, ...options } = first.options;
    const parsedBody = { ...options, content: first.content, images: first.images };
    const request = { sessionId, sessionPath, session, lease, parsedBody, queuedMessages, queueIntentId: force.id };
    if (operationKind === 'message') {
      await new StreamChatMessageEndpoint().executeDetached(this.ctx, { ...request, value: { content: first.content, images: first.images, assistantContent: '', maxTurns: options.maxTurns, webSearchOverride: options.webSearchOverride } });
    } else {
      const repoRoot = resolve(options.repoRoot ?? session.planRepoRoot);
      if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) throw new Error('Expected existing repoRoot directory.');
      const value = { content: first.content, images: first.images, repoRoot, maxTurns: options.maxTurns };
      if (operationKind === 'repo-agent') {
        await new StreamChatRepoAgentEndpoint().executeDetached(this.ctx, {
          ...request, value: {
            ...value, approval: options.approval ?? DEFAULT_APPROVAL_MODE,
            mockResponses: options.mockResponses ? MockPlannerResponsesSchema.parse(options.mockResponses) : undefined,
            mockCommandResults: options.mockCommandResults ? z.record(z.string(), RepoSearchMockCommandResultSchema).parse(options.mockCommandResults) : undefined,
          },
        });
      } else await new StreamChatRepoOperationEndpoint(operationKind).executeDetached(this.ctx, { ...request, value });
    }
    await awaitRepoSearchRunPersistence();
    this.ctx.chatSessionOperations.finish(lease, { kind: 'completed' });
    const completed = this.ctx.chatSessionOperations.getCompletion(sessionId, lease.operationId);
    if (completed?.kind === 'failed') this.fail(sessionId, force, completed.error);
    else await this.startPending(sessionId);
    this.ctx.chatMessageQueue.publish(sessionId);
  }
}
