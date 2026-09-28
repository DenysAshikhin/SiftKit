import {
  buildLiveUserMessage,
  LIVE_USER_MESSAGE_ID,
  upsertLiveMessageInto,
} from './chat-live-messages';
import type { ChatMessage, ChatSessionOperationKind, ContextUsage } from '../types';
import {
  DEFAULT_APPROVAL_MODE,
  type ApprovalMode,
  type ChatStreamApproval,
  type ChatStreamPromptEvent,
  type ChatStreamUsageEvent,
  type ChatMessageQueueState,
  type ChatOperationSnapshot,
  type ChatProjectionTerminalRecord,
  type ChatRecoveryIssue,
  type ChatRecoveryStatus,
  type ChatRecoveryReport,
  type ChatSubmissionPhase,
  type ChatSubmissionId,
} from '@siftkit/contracts';
import type { PendingImage } from './downscale-image';

export type ChatSessionActivity =
  | { kind: 'idle' }
  | { kind: 'local'; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'remote'; operationKind: ChatSessionOperationKind };

export type SubmittedChatInput = { content: string; images: PendingImage[] };

export type SessionIndicator = 'streaming' | 'tool' | 'failed' | 'completed';

/** The half a stream frame rewrites on every token; only live components subscribe to it. */
export type ChatSessionLive = {
  journalSnapshot: ChatOperationSnapshot | null;
  liveMessages: ChatMessage[];
  tokenTurns: ReadonlyMap<number, LiveTokenTurn>;
  /** Streamed text characters since the runtime's liveTokenBase; sizes the in-flight tail on top of it. */
  streamedCharsSinceBase: number;
};

/** Everything else; a token frame leaves it identical unless one of its fields really changes. */
export type ChatSessionRuntime = {
  recoveryStatus: ChatRecoveryStatus;
  queue: ChatMessageQueueState | null;
  sessionId: string;
  activity: ChatSessionActivity;
  error: string | null;
  warnings: string[];
  contextUsage: ContextUsage | null;
  /** The backend-measured context the running turn generates against; null before its frame. */
  liveTokenBase: ChatStreamPromptEvent | null;
  draft: string;
  pendingImages: PendingImage[];
  submittedInput: SubmittedChatInput | null;
  submissionPhase: ChatSubmissionPhase | null;
  ownedSubmissionId: ChatSubmissionId | null;
  /** The submitted turn has produced nothing yet; cleared by the first streamed evidence. */
  awaitingResponse: boolean;
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  pendingApproval: ChatStreamApproval | null;
  repoAgentApprovalMode: ApprovalMode;
  /** Derived from both halves on every apply; null defers to the stored session's last exit code. */
  indicator: SessionIndicator | null;
  /** Derived: the live rows carry a compaction summary, which re-segments the stored rows after the last stored one. */
  liveClosesFold: boolean;
};

type LiveTokenTurn = {
  prompt: ChatStreamPromptEvent | null;
  usage: ChatStreamUsageEvent | null;
};

type SessionState = { runtime: ChatSessionRuntime; live: ChatSessionLive };

export type ChatSessionRuntimeTransition =
  | { kind: 'recovery'; sessionId: string; reports: ChatRecoveryReport[] }
  | { kind: 'snapshot'; sessionId: string; snapshot: ChatOperationSnapshot }
  | { kind: 'queue'; sessionId: string; queue: ChatMessageQueueState }
  | { kind: 'queued-submit'; sessionId: string; content: string; images: PendingImage[] }
  | { kind: 'begin'; sessionId: string; operationKind: ChatSessionOperationKind; operationId: string; submissionId?: ChatSubmissionId }
  | { kind: 'attach'; sessionId: string; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'detach'; sessionId: string }
  | { kind: 'remote-begin'; sessionId: string; operationKind: ChatSessionOperationKind }
  | { kind: 'remote-clear'; sessionId: string }
  | { kind: 'approval-clear'; sessionId: string }
  | { kind: 'submit'; sessionId: string; content: string; images: PendingImage[]; submissionId?: ChatSubmissionId }
  /** The run settled; the stored session is refreshed through REST, so the live view retires. */
  | { kind: 'terminal'; sessionId: string; terminal: ChatProjectionTerminalRecord }
  | { kind: 'failure'; sessionId: string; message: string; issue?: ChatRecoveryIssue }
  | { kind: 'interrupted'; sessionId: string; message: string; submissionId?: ChatSubmissionId }
  | { kind: 'submission-phase'; sessionId: string; submissionId: ChatSubmissionId; phase: ChatSubmissionPhase }
  | { kind: 'control-error'; sessionId: string; message: ChatSessionRuntime['error'] }
  | { kind: 'context-usage'; sessionId: string; contextUsage: ContextUsage }
  | { kind: 'draft'; sessionId: string; draft: string }
  | { kind: 'images'; sessionId: string; images: PendingImage[] }
  | { kind: 'append-images'; sessionId: string; images: PendingImage[] }
  | { kind: 'plan-inputs'; sessionId: string; planRepoRootInput: string; planMaxTurnsInput: string }
  | { kind: 'repo-agent-approval-mode'; sessionId: string; approval: ApprovalMode };

function createSessionState(sessionId: string, planRepoRootInput: string): SessionState {
  return {
    runtime: {
      sessionId,
      recoveryStatus: 'ok',
      queue: null,
      activity: { kind: 'idle' },
      error: null,
      warnings: [],
      contextUsage: null,
      liveTokenBase: null,
      draft: '',
      pendingImages: [],
      submittedInput: null,
      submissionPhase: null,
      ownedSubmissionId: null,
      awaitingResponse: false,
      planRepoRootInput,
      planMaxTurnsInput: '',
      pendingApproval: null,
      repoAgentApprovalMode: DEFAULT_APPROVAL_MODE,
      indicator: null,
      liveClosesFold: false,
    },
    live: { journalSnapshot: null, liveMessages: [], tokenTurns: new Map(), streamedCharsSinceBase: 0 },
  };
}

/** Own-field Object.is equality; it compares every field, so a field added to a type later is covered too. */
function shallowEqual<T extends object>(left: T, right: T): boolean {
  if (Object.keys(left).length !== Object.keys(right).length) return false;
  for (const key in left) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

/** Keeps the previous value's identity when the next one is equal, so subscribers skip the change. */
function reuse<T extends object>(previous: T, next: T): T {
  return shallowEqual(previous, next) ? previous : next;
}

/** What the session rail shows for a runtime; null when only the stored session can say. */
function indicatorOf(runtime: ChatSessionRuntime, live: ChatSessionLive): SessionIndicator | null {
  if (runtime.activity.kind !== 'idle') {
    return live.liveMessages.some((message) => message.toolCallStatus === 'running') ? 'tool' : 'streaming';
  }
  if (runtime.error) return 'failed';
  const last = live.liveMessages[live.liveMessages.length - 1];
  if (!last) return null;
  const exitCode = last.toolCallExitCode ?? null;
  return exitCode !== null && exitCode !== 0 ? 'failed' : 'completed';
}

/** A turn's live rows, which stop being true the moment a stream stops feeding this session. */
function clearedLiveTurn(live: ChatSessionLive): ChatSessionLive {
  return { ...live, liveMessages: [], tokenTurns: new Map() };
}

const CLEARED_TURN_INPUTS = { submittedInput: null, awaitingResponse: false, pendingApproval: null } as const;

function withoutLiveUserMessage(live: ChatSessionLive): ChatSessionLive {
  return { ...live, liveMessages: live.liveMessages.filter(message => message.id !== LIVE_USER_MESSAGE_ID) };
}

function applyTransition(state: SessionState, transition: ChatSessionRuntimeTransition): SessionState {
  const { runtime, live } = state;
  switch (transition.kind) {
    case 'recovery': {
      if (transition.reports.some(report => report.sessionId !== runtime.sessionId)) throw new Error('Chat recovery report session mismatch.');
      const recoveryStatus = transition.reports.some(report => report.status === 'recovery_failed') ? 'recovery_failed'
        : transition.reports.some(report => report.status === 'recovery_needed') ? 'recovery_needed' : 'ok';
      return { runtime: { ...runtime, recoveryStatus }, live };
    }
    case 'snapshot': {
      const snapshot = transition.snapshot;
      if (snapshot.sessionId !== runtime.sessionId) throw new Error('Invalid chat runtime snapshot.');
      const previous = live.journalSnapshot;
      if (previous && (snapshot.runOrder < previous.runOrder
        || snapshot.operationId === previous.operationId && snapshot.cursor.sequence < previous.cursor.sequence)) return state;
      if (runtime.activity.kind === 'local' && previous && previous.controlOperationId !== runtime.activity.operationId
        && snapshot.operationId === previous.operationId) return state;
      const activity: ChatSessionActivity = snapshot.terminalCause !== null ? { kind: 'idle' }
        : snapshot.controlOperationId !== null ? { kind: 'local', operationKind: snapshot.operationKind, operationId: snapshot.controlOperationId }
          : { kind: 'remote', operationKind: snapshot.operationKind };
      return {
        // Every frame rebuilds these values; reusing equal ones keeps the runtime identical per token.
        runtime: { ...runtime, recoveryStatus: snapshot.status, activity: reuse(runtime.activity, activity),
          awaitingResponse: false,
          pendingApproval: snapshot.approval?.actionable ? snapshot.approval : null,
          liveTokenBase: [...snapshot.tokenTurns].reverse().find(turn => turn.prompt !== null)?.prompt ?? null,
          warnings: reuse(runtime.warnings, snapshot.warnings),
          error: snapshot.status === 'recovery_failed' ? 'Chat recovery requires repair before continuing.' : null },
        live: { journalSnapshot: snapshot, liveMessages: snapshot.messages,
          tokenTurns: new Map(snapshot.tokenTurns.map(turn => [turn.turn, { prompt: turn.prompt, usage: turn.usage }])),
          streamedCharsSinceBase: snapshot.streamedCharsSinceBase },
      };
    }
    case 'queue':
      if (transition.queue.sessionId !== runtime.sessionId) throw new Error('Queue session mismatch.');
      return runtime.queue && runtime.queue.revision > transition.queue.revision
        ? state : { runtime: { ...runtime, queue: transition.queue }, live };
    case 'queued-submit':
      return {
        runtime: {
          ...runtime,
          error: null,
          draft: runtime.draft.trim() === transition.content ? '' : runtime.draft,
          pendingImages: runtime.pendingImages.filter((image) => !transition.images.includes(image)),
        },
        live,
      };
    case 'begin':
      // A new run measures its own prompt: the previous run's base counts a context this one
      // no longer generates against, so the bar would restart behind itself if it survived.
      return {
        runtime: {
          ...runtime,
          activity: { kind: 'local', operationKind: transition.operationKind, operationId: transition.operationId },
          liveTokenBase: null,
          ...(transition.submissionId ? { ownedSubmissionId: transition.submissionId, submissionPhase: 'sending' as const } : {}),
        },
        live: { ...live, tokenTurns: new Map(), streamedCharsSinceBase: 0 },
      };
    case 'attach':
      // Adopting a run in flight: the replay that follows rebuilds the whole live transcript, so
      // anything left over from a previous view of this session would be counted twice. The draft
      // and pending images are the user's unsent work and survive.
      return {
        runtime: {
          ...runtime,
          ...CLEARED_TURN_INPUTS,
          activity: { kind: 'local', operationKind: transition.operationKind, operationId: transition.operationId },
          warnings: [],
          error: null,
          liveTokenBase: null,
        },
        live: { ...clearedLiveTurn(live), streamedCharsSinceBase: 0 },
      };
    // This client is no longer reading a stream for the session: the operation ended without a
    // payload, or the reader was aborted. Either way the live view it built is no longer current.
    case 'detach':
      return {
        runtime: { ...runtime, activity: { kind: 'idle' }, awaitingResponse: false, pendingApproval: null, error: null },
        live: withoutLiveUserMessage(live),
      };
    case 'remote-begin':
      return { runtime: { ...runtime, activity: { kind: 'remote', operationKind: transition.operationKind } }, live };
    case 'remote-clear':
      return runtime.activity.kind === 'remote'
        ? { runtime: { ...runtime, activity: { kind: 'idle' }, error: null }, live }
        : state;
    case 'approval-clear':
      return { runtime: { ...runtime, pendingApproval: null }, live };
    case 'submit':
      return {
        runtime: {
          ...runtime,
          error: null,
          draft: '',
          pendingImages: [],
          submittedInput: { content: transition.content, images: transition.images },
          submissionPhase: transition.submissionId ? 'sending' : null,
          ownedSubmissionId: transition.submissionId ?? null,
          awaitingResponse: true,
          pendingApproval: null,
        },
        live: {
          ...live,
          liveMessages: upsertLiveMessageInto(
            live.liveMessages,
            buildLiveUserMessage(transition.content, transition.images.map((image) => image.dataUrl)),
          ),
        },
      };
    case 'terminal':
      if (live.journalSnapshot && transition.terminal.cursor.operationId !== live.journalSnapshot.operationId) return state;
      return {
        runtime: {
          ...runtime,
          ...CLEARED_TURN_INPUTS,
          activity: { kind: 'idle' },
          recoveryStatus: transition.terminal.issue ? 'recovery_failed' : runtime.recoveryStatus,
          error: null,
          submissionPhase: null,
          ownedSubmissionId: null,
        },
        live: { ...clearedLiveTurn(live), journalSnapshot: null },
      };
    case 'interrupted':
      return transition.submissionId && runtime.ownedSubmissionId === transition.submissionId
        ? { runtime: { ...runtime, submissionPhase: 'reconnecting', awaitingResponse: false }, live }
        : { runtime: { ...runtime, awaitingResponse: false }, live };
    case 'submission-phase':
      return runtime.ownedSubmissionId === transition.submissionId
        ? { runtime: { ...runtime, submissionPhase: transition.phase }, live }
        : state;
    case 'failure':
      return {
        runtime: {
          ...runtime,
          ...CLEARED_TURN_INPUTS,
          recoveryStatus: transition.issue ? 'recovery_failed' : runtime.recoveryStatus,
          activity: { kind: 'idle' },
          error: transition.message,
          draft: runtime.draft || runtime.submittedInput?.content || '',
          pendingImages: [...(runtime.submittedInput?.images ?? []), ...runtime.pendingImages],
          submissionPhase: null,
          ownedSubmissionId: null,
        },
        live: withoutLiveUserMessage(live),
      };
    case 'control-error':
      return { runtime: { ...runtime, error: transition.message }, live };
    case 'context-usage':
      return { runtime: { ...runtime, contextUsage: transition.contextUsage }, live };
    case 'draft':
      return { runtime: { ...runtime, draft: transition.draft }, live };
    case 'images':
      return { runtime: { ...runtime, pendingImages: transition.images }, live };
    case 'append-images':
      return { runtime: { ...runtime, pendingImages: [...runtime.pendingImages, ...transition.images] }, live };
    case 'plan-inputs':
      return {
        runtime: { ...runtime, planRepoRootInput: transition.planRepoRootInput, planMaxTurnsInput: transition.planMaxTurnsInput },
        live,
      };
    case 'repo-agent-approval-mode':
      return { runtime: { ...runtime, repoAgentApprovalMode: transition.approval }, live };
  }
}

export class ChatSessionRuntimeStore {
  /** Keeps its identity across transitions that change only live halves, so the session rail skips token frames. */
  readonly runtimes: ReadonlyMap<string, ChatSessionRuntime>;
  private readonly lives: ReadonlyMap<string, ChatSessionLive>;

  constructor(runtimes: ReadonlyMap<string, ChatSessionRuntime> = new Map(), lives: ReadonlyMap<string, ChatSessionLive> = new Map()) {
    this.runtimes = runtimes;
    this.lives = lives;
  }

  /** Readers must name a session that exists; a miss is a bug, not a default. */
  has(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  get(sessionId: string): ChatSessionRuntime {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    return runtime;
  }

  getLive(sessionId: string): ChatSessionLive {
    const live = this.lives.get(sessionId);
    if (!live) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    return live;
  }

  /** Seeds the composer repo root from the session so the default directory is visible and editable. */
  ensureSession(sessionId: string, planRepoRootInput: string): ChatSessionRuntimeStore {
    if (this.runtimes.has(sessionId)) {
      return this;
    }
    const { runtime, live } = createSessionState(sessionId, planRepoRootInput);
    return new ChatSessionRuntimeStore(new Map(this.runtimes).set(sessionId, runtime), new Map(this.lives).set(sessionId, live));
  }

  /** The single copy-on-write path: an unchanged half keeps its identity, and a no-op keeps the store. */
  apply(transition: ChatSessionRuntimeTransition): ChatSessionRuntimeStore {
    const sessionId = transition.sessionId;
    const current: SessionState = { runtime: this.get(sessionId), live: this.getLive(sessionId) };
    const next = applyTransition(current, transition);
    const runtime = reuse(current.runtime, { ...next.runtime, indicator: indicatorOf(next.runtime, next.live),
      liveClosesFold: next.live.liveMessages.some((message) => message.kind === 'compaction_summary') });
    if (runtime === current.runtime && next.live === current.live) return this;
    return new ChatSessionRuntimeStore(
      runtime === current.runtime ? this.runtimes : new Map(this.runtimes).set(sessionId, runtime),
      next.live === current.live ? this.lives : new Map(this.lives).set(sessionId, next.live),
    );
  }

  removeSession(sessionId: string): ChatSessionRuntimeStore {
    const runtimes = new Map(this.runtimes);
    const lives = new Map(this.lives);
    runtimes.delete(sessionId);
    lives.delete(sessionId);
    return new ChatSessionRuntimeStore(runtimes, lives);
  }
}
