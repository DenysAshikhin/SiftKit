import {
  buildChatRunMessageIdPrefix,
  ChatStreamQueuedUserMessageSchema,
  ChatStreamTextDeltaSchema,
  finalizeStoppedChatTranscript,
  reduceChatTranscript,
  type ChatTranscriptMessage,
  type ChatTranscriptMetadata,
  type PersistedChatTranscriptMessage,
} from '@siftkit/contracts';
import { ProgressWriter } from '../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';
import { LiveTextDeltaTracker, LIVE_TEXT_FLUSH_MAX_LATENCY_MS } from './live-text-delta.js';
import {
  forwardRepoSearchPromptEvent,
  forwardRepoSearchToolEvent,
  forwardRepoSearchUsageEvent,
  toChatStreamToolEvent,
  toChatStreamUsageEvent,
  type ChatFrameWriter,
} from './chat-stream-frames.js';
import type { ChatTurnPhaseTracker } from './chat-turn-phase-tracker.js';

/** What a run appends when it ends without an answer of its own. */
export const STOPPED_BY_USER_MARKER = '*Stopped by user.*';

export class ChatStreamProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(
    private readonly writer: ChatFrameWriter,
    private readonly phaseTracker: ChatTurnPhaseTracker | null,
    requestId: string,
    private readonly streamAnswer: boolean,
  ) {
    super();
    this.transcriptMetadata = {
      messageIdPrefix: buildChatRunMessageIdPrefix(requestId),
      sourceRunId: requestId,
      createdAtUtc: new Date().toISOString(),
    };
  }

  get enabled(): boolean {
    return true;
  }

  private readonly thinkingDeltas = new LiveTextDeltaTracker();
  private readonly narrationDeltas = new LiveTextDeltaTracker();
  private readonly answerDeltas = new LiveTextDeltaTracker();
  private readonly transcriptMetadata: ChatTranscriptMetadata;
  private transcriptMessages: ChatTranscriptMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'queued_user_message') {
      const { kind, ...payload } = event;
      const queued = ChatStreamQueuedUserMessageSchema.parse(payload);
      this.transcriptMessages = reduceChatTranscript(this.transcriptMessages, {
        kind: 'user_message',
        message: queued,
      }, this.transcriptMetadata);
      this.flushPending();
      this.writer.writeEvent('queued_user_message', {
        id: queued.id,
        turn: queued.turn,
        boundary: queued.boundary,
        content: queued.content,
        images: queued.images,
      });
      return;
    }
    if (event.kind === 'thinking') {
      this.transcriptMessages = reduceChatTranscript(this.transcriptMessages, {
        kind: 'thinking',
        delta: { turn: event.turn, offset: 0, text: event.thinkingText },
      }, this.transcriptMetadata);
      this.phaseTracker?.observeThinking(event.thinkingText);
      this.thinkingDeltas.pushSnapshot(event.turn, event.thinkingText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'narration') {
      this.transcriptMessages = reduceChatTranscript(this.transcriptMessages, {
        kind: 'narration',
        delta: { turn: event.turn, offset: 0, text: event.narrationText },
      }, this.transcriptMetadata);
      this.narrationDeltas.pushSnapshot(event.turn, event.narrationText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'answer') {
      this.transcriptMessages = reduceChatTranscript(this.transcriptMessages, {
        kind: 'answer',
        delta: { turn: event.turn, offset: 0, text: event.answerText },
      }, this.transcriptMetadata);
      if (this.streamAnswer) {
        this.phaseTracker?.observeAnswer(event.answerText);
        this.answerDeltas.pushSnapshot(event.turn, event.answerText, Date.now());
        this.emitDueDeltas(false);
      }
      return;
    }
    if (event.kind === 'context_warning') {
      this.flushPending();
      this.writer.writeEvent('warning', { warning: event.warningText });
      return;
    }
    if (event.kind === 'progress_update') {
      this.transcriptMessages = reduceChatTranscript(this.transcriptMessages, {
        kind: 'progress',
        progress: {
          turn: event.turn,
          text: event.progressText,
          elapsedMs: event.elapsedMs,
        },
      }, this.transcriptMetadata);
      this.flushPending();
      this.writer.writeEvent('progress', {
        turn: event.turn,
        text: event.progressText,
        elapsedMs: event.elapsedMs,
      });
      return;
    }
    if (event.kind === 'usage') {
      this.flushPending();
      this.transcriptMessages = reduceChatTranscript(this.transcriptMessages, {
        kind: 'usage', usage: toChatStreamUsageEvent(event),
      }, this.transcriptMetadata);
      forwardRepoSearchUsageEvent(this.writer, event);
      return;
    }
    if (event.kind === 'prompt') {
      // The frame rebases the client's streaming tail, so text buffered against the previous
      // base has to reach the client before it arrives.
      this.flushPending();
      forwardRepoSearchPromptEvent(this.writer, event);
      return;
    }
    if (event.kind !== 'tool_start' && event.kind !== 'tool_result') {
      this.flushPending();
      return;
    }
    const toolEvent = toChatStreamToolEvent(event);
    this.transcriptMessages = reduceChatTranscript(this.transcriptMessages, {
      kind: 'tool',
      tool: toolEvent,
    }, this.transcriptMetadata);
    this.flushPending();
    forwardRepoSearchToolEvent(this.writer, toolEvent);
  }

  flushPending(): void {
    this.emitDueDeltas(true);
  }

  getStoppedMessages(marker = STOPPED_BY_USER_MARKER): PersistedChatTranscriptMessage[] {
    return finalizeStoppedChatTranscript(
      this.transcriptMessages,
      marker,
      this.transcriptMetadata,
    );
  }

  private emitDueDeltas(force: boolean): void {
    const now = Date.now();
    this.emitTrackerDeltas(this.thinkingDeltas, 'thinking', now, force);
    this.emitTrackerDeltas(this.narrationDeltas, 'narration', now, force);
    this.emitTrackerDeltas(this.answerDeltas, 'answer', now, force);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.thinkingDeltas.hasPending() || this.narrationDeltas.hasPending() || this.answerDeltas.hasPending()) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.emitDueDeltas(true);
      }, LIVE_TEXT_FLUSH_MAX_LATENCY_MS);
    }
  }

  private emitTrackerDeltas(
    tracker: LiveTextDeltaTracker,
    event: 'thinking' | 'narration' | 'answer',
    now: number,
    force: boolean,
  ): void {
    for (
      let delta = tracker.takeDue(now, force);
      delta !== null;
      delta = tracker.takeDue(now, force)
    ) {
      this.writer.writeEvent(event, ChatStreamTextDeltaSchema.parse(delta));
    }
  }
}
