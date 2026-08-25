import { randomUUID } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { getAbortError } from '../../lib/abort.js';
import { ServerLogger, serverLogger, shortenRequestId } from '../../status-server/server-logger.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../types.js';
import type { ChatMessage } from '../planner-protocol.js';
import type { JsonObject } from '../../lib/json-types.js';

const LOGGED_COMMAND_MAX_CHARS = 100;

function truncateForLog(command: string): string {
  return command.length <= LOGGED_COMMAND_MAX_CHARS
    ? command
    : `${command.slice(0, LOGGED_COMMAND_MAX_CHARS)}…`;
}

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

export type HumanApprovalRequestInput = {
  turn: number;
  toolName: string;
  command: string;
  reviewPayload: string | null;
};

export type ApprovalRequestInput = HumanApprovalRequestInput & {
  pendingMessages: ChatMessage[];
};

export function buildApprovalReviewPayload(input: {
  toolName: string;
  args: JsonObject;
}): string | null {
  if (input.toolName !== 'edit' && input.toolName !== 'write') return null;
  return JSON.stringify({ action: 'tool', toolName: input.toolName, args: input.args }, null, 2);
}

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

export type HumanApprovalRequester = {
  request(input: HumanApprovalRequestInput): Promise<ApprovalDecision>;
};

export type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'deny'; reason: string }
  | { kind: 'abort'; reason: string };

/** Observes gate lifecycle so a run owner can mirror decisions into durable state. */
export type ApprovalGateObserver = {
  onDecision(decision: ApprovalDecision): void;
  onTimeout(): void;
};

/** Wording for an abort a human entered, wherever they entered it. */
export const CLIENT_ABORT_MESSAGE = 'Aborted by user.';

export function toApprovalDecision(request: RepoSearchApprovalRequest): ApprovalDecision {
  if (request.decision === 'deny') {
    return { kind: 'deny', reason: (request.reason ?? '').trim() };
  }
  if (request.decision === 'abort') {
    return { kind: 'abort', reason: CLIENT_ABORT_MESSAGE };
  }
  return { kind: 'approve' };
}

/**
 * How long a pending approval waits for a decision before the run is stopped.
 *
 * Shared with the repo-agent `decide` flow so both ways of answering an approval expire together.
 * The wait must be bounded: a run parked here holds the model lock, so a caller that never answers
 * — a CLI run, or a client that ignores approval frames — would wedge the server for every later
 * request. It must also stay well under the server's model-lock hold ceiling, or the lock would be
 * force-released out from under a run that still believes it holds it. Expiry aborts the run rather
 * than denying the command, so an unanswered approval cannot be silently absorbed by the planner.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 600_000;

/** One wording for an expired approval, shared by the gate and the repo-agent prompter. */
export function buildApprovalTimeoutMessage(timeoutMs: number): string {
  return `No approval decision was received within ${timeoutMs}ms; the run was stopped (approval timeout).`;
}

function buildObserverFailureMessage(error: Error | null): string {
  return error
    ? `Approval observer failed: ${error.message}`
    : 'Approval observer failed.';
}

type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  abortListener: () => void;
  timeoutHandle: NodeJS.Timeout | null;
  startedAtMs: number;
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
  private readonly logger: ServerLogger;
  private readonly observer: ApprovalGateObserver | undefined;

  constructor(options: {
    requestId: string;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    abortSignal: AbortSignal;
    bypassReadOnlyTools: boolean;
    decisionTimeoutMs?: number;
    logger?: ServerLogger;
    observer?: ApprovalGateObserver;
  }) {
    this.logger = options.logger ?? serverLogger;
    this.requestId = options.requestId;
    this.progressWriter = options.progressWriter;
    this.abortSignal = options.abortSignal;
    this.bypassReadOnlyTools = options.bypassReadOnlyTools;
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.observer = options.observer;
    if (!Number.isFinite(this.decisionTimeoutMs) || this.decisionTimeoutMs <= 0) {
      throw new Error('Approval decision timeout must be a positive number of milliseconds.');
    }
  }

  getRequestId(): string {
    return this.requestId;
  }

  request(input: HumanApprovalRequestInput): Promise<ApprovalDecision> {
    if (this.bypassReadOnlyTools && isApprovalExemptReadOnlyTool(input.toolName)) {
      return Promise.resolve({ kind: 'approve' });
    }
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const abortListener = () => {
        const parked = entry.timeoutHandle !== null;
        this.clearPending(approvalId);
        if (parked) {
          this.logger.dim({
            scope: 'rs',
            id: this.requestId,
            event: 'approval_abandoned',
            fields: `approval=${shortenRequestId(approvalId)} reason=client_disconnected`,
          });
        }
        reject(getAbortError(this.abortSignal));
      };
      const entry: PendingApproval = {
        resolve,
        abortListener,
        timeoutHandle: null,
        startedAtMs: Date.now(),
      };
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
        this.logger.error({
          scope: 'rs',
          id: this.requestId,
          event: 'approval_timeout',
          fields: `approval=${shortenRequestId(approvalId)} tool=${input.toolName} `
            + `waited_ms=${this.decisionTimeoutMs}`,
        });
        try {
          this.observer?.onTimeout();
          resolve({ kind: 'abort', reason: buildApprovalTimeoutMessage(this.decisionTimeoutMs) });
        } catch (error) {
          resolve({
            kind: 'abort',
            reason: buildObserverFailureMessage(error instanceof Error ? error : null),
          });
        }
      }, this.decisionTimeoutMs);
      try {
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
        this.logger.warning({
          scope: 'rs',
          id: this.requestId,
          event: 'approval_wait',
          fields: `approval=${shortenRequestId(approvalId)} tool=${input.toolName} `
            + `timeout_ms=${this.decisionTimeoutMs} command=${truncateForLog(input.command)}`,
        });
      } catch (error) {
        this.clearPending(approvalId);
        throw error;
      }
    });
  }

  submit(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return false;
    }
    this.clearPending(approvalId);
    this.logger.event({
      scope: 'rs',
      id: this.requestId,
      event: 'approval_decision',
      fields: `approval=${shortenRequestId(approvalId)} decision=${decision.kind} `
        + `waited_ms=${Date.now() - entry.startedAtMs}`,
    });
    try {
      this.observer?.onDecision(decision);
      entry.resolve(decision);
    } catch (error) {
      entry.resolve({
        kind: 'abort',
        reason: buildObserverFailureMessage(error instanceof Error ? error : null),
      });
    }
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
