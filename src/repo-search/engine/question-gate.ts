import { randomUUID } from 'node:crypto';
import type { ChatQuestionReply } from '@siftkit/contracts';
import { getAbortError } from '../../lib/abort.js';
import type { ChatToolCallIdentity } from '../../state/chat-journal-schema.js';
import { DEFAULT_DECISION_TIMEOUT_MS } from './approval-gate.js';
import type { ChatQuestionRequestedEvidence, ChatQuestionResolvedEvidence } from './chat-run-evidence.js';

/** What a question commits; the chat run recorder is the production implementation. */
export interface QuestionEvidenceSink {
  readonly abortSignal: AbortSignal;
  recordQuestionRequested(evidence: ChatQuestionRequestedEvidence): void;
  recordQuestionResolved(evidence: ChatQuestionResolvedEvidence): void;
}

export type QuestionAnswerResult = 'answered' | 'not_pending' | 'invalid_choice';

type PendingQuestion = {
  questionId: string;
  choiceCount: number;
  expiresAtMs: number;
  timeoutHandle: NodeJS.Timeout;
  abortListener: () => void;
  resolve(reply: ChatQuestionReply): void;
  reject(error: Error): void;
};

type Settlement = { outcome: 'answered'; reply: ChatQuestionReply } | { outcome: 'aborted' | 'timeout'; error: Error };

export function buildQuestionTimeoutMessage(timeoutMs: number): string {
  return `No answer to the question was received within ${timeoutMs}ms; the run was stopped (question timeout).`;
}

export function formatQuestionReply(choices: readonly string[], reply: ChatQuestionReply): string {
  const lines = reply.choiceIndex === null ? [] : [`The user chose: ${choices[reply.choiceIndex] ?? `option ${reply.choiceIndex + 1}`}`];
  if (reply.note) lines.push(reply.choiceIndex === null ? `The user replied: ${reply.note}` : `The user added: ${reply.note}`);
  return lines.join('\n');
}

/**
 * Parks one ask_user call until the user answers. Stop or expiry ends the run: the wait holds the
 * model lock, so it is bounded by the same window as an approval.
 */
export class QuestionGate {
  private pending: PendingQuestion | null = null;

  constructor(private readonly sink: QuestionEvidenceSink, private readonly timeoutMs = DEFAULT_DECISION_TIMEOUT_MS) {}

  get pendingQuestionId(): string | null {
    return this.pending?.questionId ?? null;
  }

  ask(input: { call: ChatToolCallIdentity; question: string; choices: string[] }): Promise<ChatQuestionReply> {
    if (this.pending) throw new Error('A question is already waiting for an answer.');
    const signal = this.sink.abortSignal;
    if (signal.aborted) return Promise.reject(getAbortError(signal));
    const questionId = randomUUID();
    const requestedAtMs = Date.now();
    this.sink.recordQuestionRequested({
      call: input.call, questionId, question: input.question, choices: input.choices,
      requestedAtUtc: new Date(requestedAtMs).toISOString(), expiresAtUtc: new Date(requestedAtMs + this.timeoutMs).toISOString(),
    });
    return new Promise<ChatQuestionReply>((resolve, reject) => {
      const abortListener = (): void => this.settle(questionId, { outcome: 'aborted', error: getAbortError(signal) });
      // Not unref'd: the run cannot finish while parked, and every settle path clears it.
      const timeoutHandle = setTimeout(
        () => this.settle(questionId, { outcome: 'timeout', error: new Error(buildQuestionTimeoutMessage(this.timeoutMs)) }),
        this.timeoutMs,
      );
      this.pending = { questionId, choiceCount: input.choices.length, expiresAtMs: requestedAtMs + this.timeoutMs,
        timeoutHandle, abortListener, resolve, reject };
      signal.addEventListener('abort', abortListener, { once: true });
    });
  }

  answer(questionId: string, reply: ChatQuestionReply): QuestionAnswerResult {
    const pending = this.pending;
    if (pending?.questionId !== questionId) return 'not_pending';
    if (reply.choiceIndex !== null && reply.choiceIndex >= pending.choiceCount) return 'invalid_choice';
    if (Date.now() >= pending.expiresAtMs) {
      this.settle(questionId, { outcome: 'timeout', error: new Error(buildQuestionTimeoutMessage(this.timeoutMs)) });
      return 'not_pending';
    }
    this.settle(questionId, { outcome: 'answered', reply });
    return 'answered';
  }

  private settle(questionId: string, settlement: Settlement): void {
    const pending = this.pending;
    if (pending?.questionId !== questionId) return;
    this.pending = null;
    clearTimeout(pending.timeoutHandle);
    this.sink.abortSignal.removeEventListener('abort', pending.abortListener);
    try {
      this.sink.recordQuestionResolved({ questionId, outcome: settlement.outcome,
        reply: settlement.outcome === 'answered' ? settlement.reply : null, decidedAtUtc: new Date().toISOString() });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (settlement.outcome === 'answered') pending.resolve(settlement.reply);
    else pending.reject(settlement.error);
  }
}
