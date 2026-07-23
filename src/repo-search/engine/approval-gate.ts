import { randomUUID } from 'node:crypto';
import { z } from '../../lib/zod.js';
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

export type ApprovalRequestInput = { turn: number; toolName: string; command: string };

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

type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  timeoutHandle: NodeJS.Timeout;
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
  private readonly timeoutMs: number;

  constructor(options: {
    requestId: string;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    timeoutMs: number;
  }) {
    this.requestId = options.requestId;
    this.progressWriter = options.progressWriter;
    this.timeoutMs = options.timeoutMs;
  }

  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(approvalId);
        reject(new Error(`Approval request timed out after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      timeoutHandle.unref?.();
      this.pending.set(approvalId, { resolve, timeoutHandle });
      this.progressWriter.write({
        kind: 'approval_request',
        requestId: this.requestId,
        approvalId,
        turn: input.turn,
        toolName: input.toolName,
        command: input.command,
      });
    });
  }

  submit(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return false;
    }
    this.pending.delete(approvalId);
    clearTimeout(entry.timeoutHandle);
    entry.resolve(decision);
    return true;
  }
}
