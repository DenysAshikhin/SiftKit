import { createHash, randomUUID } from 'node:crypto';
import { PersistedChatTranscriptMessageSchema, type ChatRunTerminalCause } from '@siftkit/contracts';
import type { SiftConfig } from '../config/types.js';
import { stableStringify } from '../lib/json.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { selectReplayableChatMessages, shouldPreserveThinking, trimText } from './chat.js';
import type { ReplayableChatMessage } from '@siftkit/contracts';
import { getActiveModelPreset } from '../config/getters.js';
import type { ChatMessage as PlannerChatMessage } from '../repo-search/planner-chat-message.js';
import { buildCompactionSummaryMessage } from '../repo-search/engine/transcript-compactor.js';
import { ImageRetentionPolicy } from '../image-retention-policy.js';
import { buildReplayToolCall } from '../llm-protocol/tool-call-parser.js';
import { buildUserContent } from '../llm-protocol/image-attachments.js';
import { requireDurableToolResult } from './chat-tool-results.js';
import { reconcileChatRun } from './chat-run-projection.js';
import type { ChatEngineBinding, ChatJournalEvent, ChatRunStart } from '../state/chat-journal-schema.js';

/** One baseline record, shared by admission migration and explicit archive repair. */
export function recordImportedChatBaseline(database: RuntimeDatabase, options:
  Pick<ChatRunStart, 'sessionId' | 'ownerEpoch' | 'createdAtUtc'> & {
    event: Extract<ChatJournalEvent, { kind: 'baseline_imported' }>;
    terminalCause: ChatRunTerminalCause;
    updatedAtUtc: string;
    binding: Pick<ChatEngineBinding, 'requestId' | 'repoAgentSessionId'> | null;
  }): string {
  const store = new ChatJournalStore(database);
  const operationId = randomUUID();
  database.transaction(() => {
    store.begin({ operationId, sessionId: options.sessionId, recordKind: 'baseline', operationKind: null,
      ownerEpoch: options.ownerEpoch, settings: null, provenance: options.event.provenance, createdAtUtc: options.createdAtUtc });
    if (options.binding) store.bindEngine({ operationId, ownerEpoch: options.ownerEpoch, ...options.binding });
    store.append({ operationId, ownerEpoch: options.ownerEpoch, expectedSequence: 0, eventId: 'baseline',
      occurredAtUtc: options.createdAtUtc, event: options.event });
    store.finish({ operationId, ownerEpoch: options.ownerEpoch, terminalCause: options.terminalCause, updatedAtUtc: options.updatedAtUtc });
  })();
  return operationId;
}

/** Explicit one-time import at admission/migration, never a provider-history fallback. */
export function importChatSessionBaseline(database: RuntimeDatabase, session: ChatSession, config: SiftConfig): void {
  const store = new ChatJournalStore(database);
  if (store.listSessionRuns(session.id).length > 0 || !session.messages?.length) return;
  const messages = PersistedChatTranscriptMessageSchema.array().parse(session.messages);
  const retainedContext = buildChatHistoryMessages(config, session);
  const provenance = {
    importerVersion: 1, sourceKind: 'saved_chat' as const, sourceId: session.id,
    sourceDigest: createHash('sha256').update(stableStringify(messages)).digest('hex'),
  };
  const now = new Date().toISOString();
  const operationId = recordImportedChatBaseline(database, {
    sessionId: session.id, ownerEpoch: 'baseline-import', createdAtUtc: now, updatedAtUtc: now,
    terminalCause: 'completed', binding: null, event: { kind: 'baseline_imported', messages, retainedContext, provenance },
  });
  const report = reconcileChatRun(database, operationId);
  if (report.status === 'recovery_failed') throw new Error('Imported chat baseline requires projection recovery.');
}

/**
 * Deleted attachments are stored as a count, never written into the message text. The notice
 * is composed here so the model does not read a dangling reference to an image that is gone.
 */
function appendRemovedImageNotice(content: string, removedImageCount: number): string {
  if (removedImageCount <= 0) {
    return content;
  }
  const notice = removedImageCount === 1
    ? '[1 image removed]'
    : `[${removedImageCount} images removed]`;
  return content ? `${content}\n${notice}` : notice;
}

/** Legacy saved rows read as planner context: used only by the one-time baseline import. */
export function buildChatHistoryMessages(
  config: SiftConfig,
  session: ChatSession,
): PlannerChatMessage[] {
  const messages = selectReplayableChatMessages(
    Array.isArray(session.messages) ? session.messages : [],
  );
  const history: PlannerChatMessage[] = [];
  const replayThinking = shouldPreserveThinking(config, session.thinkingEnabled !== false);
  let pendingThinking = '';
  let pendingThinkingMessageId: string | undefined;
  for (const message of messages) {
    const kind = message.kind;
    if (kind === 'compaction_summary') {
      const summaryText = trimText(message.content);
      if (summaryText) {
        history.push({ ...buildCompactionSummaryMessage(summaryText), chatMessageId: message.id });
      }
      pendingThinking = '';
      pendingThinkingMessageId = undefined;
      continue;
    }
    if (kind === 'assistant_thinking') {
      if (replayThinking) {
        pendingThinking = trimText(message.content);
        pendingThinkingMessageId = message.id;
      }
      continue;
    }
    if (kind === 'assistant_tool_call') {
      appendReplayToolMessages(history, message, pendingThinking, pendingThinkingMessageId);
      pendingThinking = '';
      pendingThinkingMessageId = undefined;
      continue;
    }
    if (kind === 'tool_image') {
      const toolImages = message.images ?? [];
      if (toolImages.length > 0) {
        const toolText = appendRemovedImageNotice(trimText(message.content), message.removedImageCount ?? 0);
        history.push({ role: 'user', content: buildUserContent(toolText, toolImages), chatMessageId: message.id });
      }
      continue;
    }
    if (kind === 'repo_agent_approval') {
      history.push({ role: 'user', content: `[repo-agent approval] ${message.content}`, chatMessageId: message.id });
      pendingThinking = '';
      pendingThinkingMessageId = undefined;
      continue;
    }
    const content = appendRemovedImageNotice(trimText(message.content), message.removedImageCount ?? 0);
    const messageImages = message.images ?? [];
    if (!content && messageImages.length === 0) {
      continue;
    }
    history.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      chatMessageId: message.id,
      content: message.role === 'user'
        ? buildUserContent(content, messageImages)
        : content,
      ...(message.role === 'assistant' && pendingThinking ? { reasoning_content: pendingThinking, thinkingMessageId: pendingThinkingMessageId } : {}),
    });
    pendingThinking = '';
    pendingThinkingMessageId = undefined;
  }
  if (pendingThinking) {
    history.push({ role: 'assistant', content: '', reasoning_content: pendingThinking, thinkingMessageId: pendingThinkingMessageId });
  }
  return [...new ImageRetentionPolicy(getActiveModelPreset(config).VisionImageRetention).prune(history).messages];
}

function buildReplayToolCallId(messageId: string): string {
  const safe = messageId.replace(/[^A-Za-z0-9_-]/gu, '_');
  return `chat_tool_${safe}`;
}

function appendReplayToolMessages(
  history: PlannerChatMessage[],
  message: ReplayableChatMessage & { kind: 'assistant_tool_call' },
  reasoningContent: string,
  thinkingMessageId: string | undefined,
): void {
  const command = trimText(message.toolCallCommand) || trimText(message.content);
  // Replayed exactly as inserted, never the preview: a completed row without its result fails loudly.
  const output = requireDurableToolResult(message);
  const toolCallId = buildReplayToolCallId(message.id);
  history.push({
    role: 'assistant',
    content: '',
    ...(reasoningContent ? { reasoning_content: reasoningContent, thinkingMessageId } : {}),
    tool_calls: [buildReplayToolCall({ id: toolCallId, command })],
  });
  history.push({
    role: 'tool',
    chatMessageId: message.id,
    tool_call_id: toolCallId,
    content: output,
  });
}

