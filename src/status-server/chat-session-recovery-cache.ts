import type { ChatRecoveryReport } from '@siftkit/contracts';
import type { RuntimeDatabase } from '../state/runtime-db.js';
import { reconcileChatSession } from './chat-run-recovery.js';

/**
 * The one owner of "what the last replay of this session's journals found".
 *
 * Replay is a restart concern: a run that finishes while this process is up is projected by its own
 * recorder, so a detail read reconciles once and later reads trust the live projection. Two rules keep
 * that memo from ever answering with a verdict older than the facts:
 * - the run-admission gate replays every time (forRunAdmission) instead of answering from the memo, since
 *   a journal can be corrupted from outside this process and a replay repairs the display evidence the
 *   reads after it depend on; only the verdict that refuses a turn is memoized;
 * - anything that changes what a replay would find — a closing run, the session row, a transcript row,
 *   a message image — invalidates the entry, so the next read replays rather than repeating a verdict
 *   made against rows that no longer exist.
 */
export class ChatSessionRecoveryCache {
  private readonly reports = new Map<string, ChatRecoveryReport[]>();

  constructor(private readonly database: RuntimeDatabase) {}

  /** Replays on this process's first read of the session; later reads return those reports. */
  forSession(sessionId: string): ChatRecoveryReport[] {
    const cached = this.reports.get(sessionId);
    if (cached) return cached;
    const reports = reconcileChatSession(this.database, sessionId);
    this.reports.set(sessionId, reports);
    return reports;
  }

  /**
   * The admission gate's path: replays now rather than answering from the memo, because a journal can
   * be corrupted from outside this process and the replay's repair of the display projection has to
   * precede the reads that follow it. Only a verdict that refuses the turn is memoized.
   */
  forRunAdmission(sessionId: string): ChatRecoveryReport[] {
    const reports = reconcileChatSession(this.database, sessionId);
    // A verdict that refuses a turn is the one no read may contradict, so it becomes the memo. A clean
    // verdict does not: the rows this replay repaired are what the next read has to report.
    if (reports.some(report => report.status === 'recovery_failed')) this.reports.set(sessionId, reports);
    return reports;
  }

  /** What forSession() has already found, without replaying: what the listing reports. */
  peek(sessionId: string): readonly ChatRecoveryReport[] {
    return this.reports.get(sessionId) ?? [];
  }

  invalidate(sessionId: string): void {
    this.reports.delete(sessionId);
  }
}