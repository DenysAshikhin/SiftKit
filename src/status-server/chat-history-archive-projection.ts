import { ChatStreamQueuedUserMessageSchema, ImageDataUrlSchema, PersistedChatTranscriptMessageSchema, buildChatRunMessageIdPrefix, buildChatMessageId, reduceChatTranscript, type ChatTranscriptMessage } from '@siftkit/contracts';
import { reconstructChatArchiveContext, type readChatHistoryArchive } from './chat-history-archive.js';
import { z } from '../lib/zod.js';
import { PlannerChatMessagesSchema, type ChatMessage } from '../repo-search/planner-chat-message.js';
import { extractContentText } from '../llm-protocol/image-attachments.js';
import { COMPACTION_SUMMARY_MARKER } from '../repo-search/engine/transcript-compactor.js';
import { TurnCommandStartEventSchema } from '../repo-search/live-snapshot/schemas.js';
import { stableStringify } from '../lib/json.js';

const ResponseSchema = z.object({
  turn: z.number().int().positive(), text: z.string(), thinkingText: z.string(),
  promptTokens: z.number().int().nonnegative().optional(), completionTokens: z.number().int().nonnegative().optional(),
  thinkingTokens: z.number().int().nonnegative().optional(), completionTokensEstimated: z.boolean().optional(), thinkingTokensEstimated: z.boolean().optional(),
  promptCacheTokens: z.number().int().nonnegative().optional(), promptEvalTokens: z.number().int().nonnegative().optional(),
});

export function projectChatHistoryArchive(archive: ReturnType<typeof readChatHistoryArchive>, options: {
  requestId: string; maxTurns: number; includeThinking: boolean;
}) {
  z.number().int().positive().parse(options.maxTurns);
  const messageIdPrefix = buildChatRunMessageIdPrefix(options.requestId);
  const outcomes = new Map(archive.tools.outcomes.map(outcome => [outcome.toolCallId, outcome]));
  let messages: ChatTranscriptMessage[] = [];
  let compacted = false;
  for (const entry of archive.events) {
    const createdAtUtc = z.string().datetime().parse(entry.event.at);
    const metadata = { messageIdPrefix, sourceRunId: null, createdAtUtc };
    if (entry.kind === 'turn_preflight_compaction_applied') compacted = true;
    if (entry.kind === 'turn_new_messages') {
      const context = z.object({ turn: z.number(), messages: PlannerChatMessagesSchema }).parse(entry.event);
      if (context.turn === 1) {
        const submission = context.messages.find(message => message.role === 'user');
        if (!submission) throw new Error(`Archive line ${entry.lineNumber} has no original submission.`);
        const images = Array.isArray(submission.content)
          ? submission.content.flatMap(part => part.type === 'image_url' ? [ImageDataUrlSchema.parse(part.image_url?.url)] : []) : [];
        // Legacy archives recorded image payloads but never their admission metadata.
        messages = reduceChatTranscript(messages, { kind: 'submission', message: {
          id: buildChatMessageId(messageIdPrefix, { kind: 'user' }), content: extractContentText(submission.content), images, imageMeta: [],
        } }, metadata);
      }
      if (compacted) {
        const summary = context.messages.find(message => message.role === 'assistant'
          && typeof message.content === 'string' && message.content.startsWith(COMPACTION_SUMMARY_MARKER));
        if (!summary) throw new Error(`Archive line ${entry.lineNumber} is missing its compaction summary.`);
        messages.push(PersistedChatTranscriptMessageSchema.parse({
          id: buildChatMessageId(messageIdPrefix, { kind: 'summary', revision: context.turn }), role: 'assistant', kind: 'compaction_summary',
          content: extractContentText(summary.content), createdAtUtc, inputTokensEstimate: 0, outputTokensEstimate: 0,
          thinkingTokens: 0, outputTokensEstimated: true,
        }));
        compacted = false;
      }
    }
    if (entry.kind === 'queued_user_message') {
      const message = ChatStreamQueuedUserMessageSchema.parse({
        id: entry.event.id, turn: entry.event.turn, boundary: entry.event.boundary,
        content: entry.event.content, images: entry.event.images, imageMeta: [],
      });
      messages = reduceChatTranscript(messages, { kind: 'user_message', message }, metadata);
    }
    if (entry.kind === 'turn_model_response') {
      const response = ResponseSchema.parse(entry.event);
      if (options.includeThinking && response.thinkingText) messages = reduceChatTranscript(messages, {
        kind: 'thinking', delta: { turn: response.turn, offset: 0, text: response.thinkingText },
      }, metadata);
      if (response.text) messages = reduceChatTranscript(messages, {
        kind: 'narration', delta: { turn: response.turn, offset: 0, text: response.text },
      }, metadata);
      const textId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'narration', turn: response.turn });
      const thinkingId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'thinking', turn: response.turn });
      messages = messages.map(message => message.id === textId ? {
        ...message, inputTokensEstimate: response.promptTokens ?? 0, inputTokensEstimated: response.promptTokens === undefined,
        outputTokensEstimate: response.completionTokens ?? 0, outputTokensEstimated: response.completionTokensEstimated ?? response.completionTokens === undefined,
        promptCacheTokens: response.promptCacheTokens, promptEvalTokens: response.promptEvalTokens,
      } : message.id === thinkingId ? { ...message, thinkingTokens: response.thinkingTokens ?? 0,
        thinkingTokensEstimated: response.thinkingTokensEstimated ?? response.thinkingTokens === undefined } : message);
    }
    if (entry.kind === 'turn_command_start') {
      const start = TurnCommandStartEventSchema.parse(entry.event);
      messages = reduceChatTranscript(messages, { kind: 'tool', tool: {
        kind: 'tool_start', toolCallId: start.toolCallId, turn: start.turn, maxTurns: options.maxTurns,
        activityKind: 'command', activitySubject: { kind: 'none' }, command: start.commandToRun, promptTokenCount: 0,
      } }, metadata);
    }
    if (entry.kind === 'turn_command_result') {
      const toolCallId = z.string().min(1).parse(entry.event.toolCallId);
      const outcome = outcomes.get(toolCallId);
      if (!outcome) throw new Error(`Archive line ${entry.lineNumber} has no verified result.`);
      const tokens = z.number().int().nonnegative().optional().parse(entry.event.resultTokenCount);
      messages = reduceChatTranscript(messages, { kind: 'tool_outcome', outcome: {
        toolCallId, executionState: outcome.exitCode === null ? 'rejected' : 'completed', exitCode: outcome.exitCode,
        output: outcome.output, outputTokens: tokens ?? 0, outputTokensEstimated: tokens === undefined,
      } }, metadata);
    }
  }
  messages = messages.map(message => message.kind === 'assistant_tool_call' && message.toolCallExecutionState === 'executing'
    ? { ...message, toolCallExecutionState: 'uncertain', toolCallStatus: 'stopped' } : message);
  // Full outcomes must have a display owner; otherwise a diagnostic reader's permissive behavior
  // would hide a source mismatch at import time.
  for (const outcome of archive.tools.outcomes) {
    const toolCallId = outcome.toolCallId;
    if (toolCallId === null || !messages.some(message => message.id === buildChatMessageId(messageIdPrefix, { kind: 'tool', toolCallId }))) {
      throw new Error('Archive contains an outcome without an unambiguous display identity.');
    }
  }
  return { messages: messages.map(message => PersistedChatTranscriptMessageSchema.parse(message)),
    sourceRequestId: options.requestId, modelTurns: archive.modelTurns };
}

/** Binds retained native evidence to its exact display owners for later edits and deletion. */
export function linkChatArchiveContext(archive: ReturnType<typeof readChatHistoryArchive>, options: {
  requestId: string; includeThinking: boolean;
}) {
  const replay = reconstructChatArchiveContext(archive);
  const prefix = buildChatRunMessageIdPrefix(options.requestId);
  const responses = archive.events.filter(entry => entry.kind === 'turn_model_response').map(entry => ResponseSchema.parse(entry.event));
  const starts = archive.events.filter(entry => entry.kind === 'turn_command_start').map(entry => TurnCommandStartEventSchema.parse(entry.event));
  const projected = projectChatHistoryArchive(archive, { ...options, maxTurns: Math.max(1, archive.modelTurns) });
  const messages: ChatMessage[] = replay.messages.map(message => ({ ...message }));
  const matchedTurns = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) throw new Error('Archive native message position is missing.');
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const calls = message.tool_calls;
      const results = messages.slice(index + 1).filter(candidate => candidate.role === 'tool').slice(0, calls.length);
      const candidates = responses.filter(response => {
        if (matchedTurns.has(response.turn)) return false;
        const recordedTurn = replay.messageTurns[index];
        if (recordedTurn !== undefined && recordedTurn > 0 && recordedTurn !== response.turn) return false;
        const outcomes = archive.tools.outcomes.filter(outcome => outcome.turn === response.turn);
        return response.text === extractContentText(message.content) && outcomes.length === calls.length
          && outcomes.every((outcome, callIndex) => {
            const result = results[callIndex];
            const call = calls[callIndex];
            const start = starts.find(candidate => candidate.toolCallId === outcome.toolCallId);
            return result?.tool_call_id === call?.id && result?.content === outcome.output
              && start?.toolName === call?.function.name;
          });
      });
      const candidate = candidates[0];
      if (candidates.length !== 1 || !candidate) throw new Error('Archive native batch has no unique matching full outcomes.');
      matchedTurns.add(candidate.turn);
      message.chatMessageId = `${prefix}-narration-${candidate.turn}`;
      if (options.includeThinking && message.reasoning_content) message.thinkingMessageId = `${prefix}-thinking-${candidate.turn}`;
      const outcomes = archive.tools.outcomes.filter(outcome => outcome.turn === candidate.turn);
      for (const [resultIndex, result] of results.entries()) {
        const outcome = outcomes[resultIndex];
        if (!outcome?.toolCallId) throw new Error('Archive native tool result is missing its display identity.');
        result.chatMessageId = buildChatMessageId(prefix, { kind: 'tool', toolCallId: outcome.toolCallId });
      }
    } else if (message.role === 'assistant' && typeof message.content === 'string') {
      const candidates = projected.messages.filter(row => row.role === 'assistant' && row.content === message.content
        && (row.kind === 'compaction_summary' || row.kind === 'assistant_narration' || row.kind === 'assistant_progress'));
      if (candidates.length > 1) throw new Error('Archive assistant message has ambiguous display ownership.');
      const candidate = candidates[0];
      if (candidate) message.chatMessageId = candidate.id;
    } else if (message.role === 'user') {
      const text = extractContentText(message.content);
      const images = Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => ImageDataUrlSchema.parse(part.image_url?.url)) : [];
      const candidates = projected.messages.filter(row => row.kind === 'user_text' && row.content === text
        && stableStringify(row.images ?? []) === stableStringify(images));
      if (candidates.length > 1) throw new Error('Archive user message has ambiguous display ownership.');
      const candidate = candidates[0];
      if (candidate) message.chatMessageId = candidate.id;
      else if (images.length > 0) throw new Error('Archive image evidence has no exact display owner.');
    }
    if (!options.includeThinking) delete message.reasoning_content;
  }
  return { ...replay, messages };
}
