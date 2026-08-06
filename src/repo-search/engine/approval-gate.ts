import { randomUUID } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { getAbortError } from '../../lib/abort.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../types.js';

export const ApprovalDecisionKindSchema = z.enum(['approve', 'deny', 'abort']);

export const RepoSearchApprovalRequestSchema = z.object({
  requestId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: ApprovalDecisionKindSchema,
  reason: z.string().optional(),
});
export type RepoSearchApprovalRequest = z.infer<typeof RepoSearchApprovalRequestSchema>;

export const RepoSearchApprovalResultSchema = z.object({ accepted: z.literal(true) });
export type RepoSearchApprovalResult = z.infer<typeof RepoSearchApprovalResultSchema>;

export const ApprovalModeSchema = z.enum(['interactive', 'auto', 'off']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export type ApprovalRequestInput = {
  turn: number;
  toolName: string;
  command: string;
  reviewPayload: string | null;
};

const APPROVAL_EXEMPT_READ_ONLY_TOOLS = new Set<string>([
  'read',
  'grep',
  'find',
  'ls',
]);

export function isApprovalExemptReadOnlyTool(toolName: string): boolean {
  return APPROVAL_EXEMPT_READ_ONLY_TOOLS.has(toolName);
}

/** Anything that can answer an approval request: the human gate or the LLM decorator. */
export type ApprovalRequester = {
  request(input: ApprovalRequestInput): Promise<ApprovalDecision>;
};

export type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'deny'; reason: string }
  | { kind: 'abort' };

export function toApprovalDecision(request: RepoSearchApprovalRequest): ApprovalDecision {
  if (request.decision === 'deny') {
    return { kind: 'deny', reason: (request.reason ?? '').trim() };
  }
  return { kind: request.decision };
}

/**
 * How long a pending approval waits for a decision before denying the command.
 *
 * Shared with the repo-agent `decide` flow so both ways of answering an approval expire together.
 * The wait must be bounded: a run parked here holds the model lock, so a caller that never answers
 * — a CLI run, or a client that ignores approval frames — would wedge the server for every later
 * request. It must also stay well under the server's model-lock hold ceiling, or the lock would be
 * force-released out from under a run that still believes it holds it.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 600_000;

/** One wording for an expired approval, so the gate and the repo-agent prompter cannot drift. */
export function buildApprovalTimeoutDenial(timeoutMs: number): ApprovalDecision {
  return {
    kind: 'deny',
    reason: `No approval decision was received within ${timeoutMs}ms; the command was not executed.`,
  };
}

type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  abortListener: () => void;
  timeoutHandle: NodeJS.Timeout | null;
};

/**
 * Parks tool execution until a human decision arrives. Emits approval_request
 * through the run's progress writer (which the SSE layer forwards); submit()
 * is called by the /repo-search/approval endpoint via the server registry.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly requestId: string;
  private readonly progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  private readonly abortSignal: AbortSignal;
  private readonly bypassReadOnlyTools: boolean;
  private readonly decisionTimeoutMs: number;

  constructor(options: {
    requestId: string;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    abortSignal: AbortSignal;
    bypassReadOnlyTools: boolean;
    decisionTimeoutMs?: number;
  }) {
    this.requestId = options.requestId;
    this.progressWriter = options.progressWriter;
    this.abortSignal = options.abortSignal;
    this.bypassReadOnlyTools = options.bypassReadOnlyTools;
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    if (!Number.isFinite(this.decisionTimeoutMs) || this.decisionTimeoutMs <= 0) {
      throw new Error('Approval decision timeout must be a positive number of milliseconds.');
    }
  }

  getRequestId(): string {
    return this.requestId;
  }

  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    if (this.bypassReadOnlyTools && isApprovalExemptReadOnlyTool(input.toolName)) {
      return Promise.resolve({ kind: 'approve' });
    }
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const abortListener = () => {
        this.clearPending(approvalId);
        reject(getAbortError(this.abortSignal));
      };
      const entry: PendingApproval = { resolve, abortListener, timeoutHandle: null };
      this.pending.set(approvalId, entry);
      this.abortSignal.addEventListener('abort', abortListener, { once: true });
      if (this.abortSignal.aborted) {
        abortListener();
        return;
      }
      // Not unref'd: this timer is the only guarantee the run resolves, and it is always cleared
      // on the paths that settle the approval, so it cannot outlive the request.
      entry.timeoutHandle = setTimeout(() => {
        this.clearPending(approvalId);
        resolve(buildApprovalTimeoutDenial(this.decisionTimeoutMs));
      }, this.decisionTimeoutMs);
      this.progressWriter.write({
        kind: 'approval_request',
        requestId: this.requestId,
        approvalId,
        turn: input.turn,
        toolName: input.toolName,
        command: input.command,
        ...(input.reviewPayload === null
          ? {}
          : { reviewPayload: input.reviewPayload }),
      });
    });
  }

  submit(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return false;
    }
    this.clearPending(approvalId);
    entry.resolve(decision);
    return true;
  }

  /** Forgets an approval and releases everything holding it open, whichever path settled it. */
  private clearPending(approvalId: string): void {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return;
    }
    this.pending.delete(approvalId);
    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
    this.abortSignal.removeEventListener('abort', entry.abortListener);
  }
}
