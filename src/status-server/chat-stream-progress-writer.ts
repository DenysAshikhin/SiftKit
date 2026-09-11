import { ChatStreamTextDeltaSchema } from '@siftkit/contracts';
import { ProgressWriter } from '../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';
import { LiveTextDeltaTracker, LIVE_TEXT_FLUSH_MAX_LATENCY_MS } from './live-text-delta.js';
import { toChatStreamToolEvent, toChatStreamUsageEvent, toChatStreamPromptEvent } from './chat-stream-frames.js';
import type { ChatOperationBroadcast } from './chat-operation-broadcast.js';
import type { ChatTurnPhaseTracker } from './chat-turn-phase-tracker.js';
import type { ChatRunRecorder } from './chat-run-recorder.js';


/** Coalesces live text; the recorder owns the transcript and commits each emitted delta before readers wake. */
export class ChatStreamProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly thinkingDeltas = new LiveTextDeltaTracker();
  private readonly narrationDeltas = new LiveTextDeltaTracker();
  private readonly answerDeltas = new LiveTextDeltaTracker();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushFailure: Error | null = null;

  constructor(
    private readonly broadcast: Pick<ChatOperationBroadcast, 'publish'>,
    private readonly phaseTracker: ChatTurnPhaseTracker | null,
    private readonly streamAnswer: boolean,
    private readonly recorder: ChatRunRecorder,
  ) { super(); recorder.attachProgress(this); }

  get enabled(): boolean { return true; }

  write(event: RepoSearchProgressEvent): void {
    if (this.flushFailure) throw this.flushFailure;
    if (event.kind === 'thinking') {
      this.phaseTracker?.observeThinking(event.thinkingText);
      this.thinkingDeltas.pushSnapshot(event.turn, event.thinkingText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'narration') {
      this.narrationDeltas.pushSnapshot(event.turn, event.narrationText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'answer') {
      if (this.streamAnswer) {
        this.phaseTracker?.observeAnswer(event.answerText);
        this.answerDeltas.pushSnapshot(event.turn, event.answerText, Date.now());
        this.emitDueDeltas(false);
      }
      return;
    }
    this.flushPending();
    if (event.kind === 'context_warning') {
      this.recorder.recordPresentation({ kind: 'warning', warning: event.warningText });
    } else if (event.kind === 'progress_update') {
      this.recorder.recordDisplay({ kind: 'progress', progress: { turn: event.turn, text: event.progressText, elapsedMs: event.elapsedMs } });
    } else if (event.kind === 'usage') {
      this.recorder.recordDisplay({ kind: 'usage', usage: toChatStreamUsageEvent(event) });
    } else if (event.kind === 'prompt') {
      this.recorder.recordPresentation({ kind: 'prompt', prompt: toChatStreamPromptEvent(event) });
    } else if (event.kind === 'tool_start' || event.kind === 'tool_result') {
      this.recorder.recordDisplay({ kind: 'tool', tool: toChatStreamToolEvent(event) });
    } else if (event.kind !== 'queued_user_message') return; // the recorder journaled the delivery when it claimed it
    this.broadcast.publish();
  }

  flushPending(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushFailure) throw this.flushFailure;
    this.emitDueDeltas(true);
  }

  private emitDueDeltas(force: boolean): void {
    const now = Date.now();
    this.emitTrackerDeltas(this.thinkingDeltas, 'thinking', now, force);
    this.emitTrackerDeltas(this.narrationDeltas, 'narration', now, force);
    this.emitTrackerDeltas(this.answerDeltas, 'answer', now, force);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.thinkingDeltas.hasPending() || this.narrationDeltas.hasPending() || this.answerDeltas.hasPending()) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        try { this.emitDueDeltas(true); }
        catch (error) {
          this.flushFailure = error instanceof Error ? error : new Error(String(error));
          this.recorder.abortForStorageFailure(this.flushFailure);
        }
      }, LIVE_TEXT_FLUSH_MAX_LATENCY_MS);
    }
  }

  private emitTrackerDeltas(tracker: LiveTextDeltaTracker, kind: 'thinking' | 'narration' | 'answer', now: number, force: boolean): void {
    for (let delta = tracker.takeDue(now, force); delta !== null; delta = tracker.takeDue(now, force)) {
      this.recorder.recordDisplay({ kind, delta: ChatStreamTextDeltaSchema.parse(delta) });
      this.broadcast.publish();
    }
  }
}
