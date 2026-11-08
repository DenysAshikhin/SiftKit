import { getErrorMessage } from '../../lib/errors.ts';
import { parseJsonValueText } from '../../lib/json.ts';
import type { ProgressWriter } from '../../lib/progress-writer.ts';
import type { RepoSearchProgressEvent } from '../types.ts';
import type { PlannerActionResponse } from '../planner-protocol.ts';
import { buildApprovalReviewRequest } from '../approval-review-policy.ts';
import {
  isApprovalExemptReadOnlyTool,
  type ApprovalDecision,
  type ApprovalRequestInput,
  type ApprovalRequester,
} from './approval-gate.ts';
import type { JsonLogger } from '../types.ts';
import { ApprovalVerdictSchema, type ApprovalVerdict } from '../approval-verdict.ts';
import type { ChatRunEvidenceRecorder } from './chat-run-evidence.ts';

const FORBIDDEN_TOOL_CALL_REASON = 'approval reviewer attempted a forbidden tool call';

type ApprovalVerdictAttempt =
  | { kind: 'verdict'; value: ApprovalVerdict }
  | { kind: 'failure'; reason: string };

/** Narrow view of TaskLoop: issues one schema-constrained verdict request for a rendered review request. */
export type ApprovalVerdictRequester = {
  requestApprovalVerdict(reviewRequest: string): Promise<PlannerActionResponse>;
};

/**
 * Decorator over the human ApprovalGate: asks the model for an approve/deny/unsure
 * verdict in a request of its own (the approver prompt and the proposed call, never
 * the agent's conversation). `unsure` and verdict failures fall through to the
 * wrapped human gate. A chat run journals every verdict before acting on it, so the
 * authorization is recoverable evidence.
 */
export class LlmApprovalGate {
  private readonly deps: {
    requestId: string;
    humanGate: ApprovalRequester;
    verdictRequester: ApprovalVerdictRequester;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    logger: JsonLogger | null;
    evidenceRecorder?: Pick<ChatRunEvidenceRecorder, 'recordApprovalReviewed'>;
  };

  constructor(deps: {
    requestId: string;
    humanGate: ApprovalRequester;
    verdictRequester: ApprovalVerdictRequester;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    logger: JsonLogger | null;
    evidenceRecorder?: Pick<ChatRunEvidenceRecorder, 'recordApprovalReviewed'>;
  }) {
    this.deps = deps;
  }

  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    // A read-only tool never reaches the reviewer. The exemption is static policy, not a verdict,
    // so it reports nothing: the tool_start line that follows already names the tool and its
    // arguments, and an approval line in front of it is pure duplication.
    if (isApprovalExemptReadOnlyTool(input.toolName)) {
      return { kind: 'approve' };
    }
    if (this.deps.evidenceRecorder && !input.call) throw new Error('Chat approval requires its exact proposed tool identity.');
    const verdict = await this.requestVerdictWithRetry(buildApprovalReviewRequest(input));
    if (verdict.kind === 'failure') {
      this.emitVerdict(input, 'unsure', verdict.reason);
      return this.deps.humanGate.request(input);
    }
    this.emitVerdict(input, verdict.value.verdict, verdict.value.reason);
    if (verdict.value.verdict === 'approve') {
      return { kind: 'approve' };
    }
    if (verdict.value.verdict === 'deny') {
      return { kind: 'deny', reason: `auto-reviewer: ${verdict.value.reason}` };
    }
    return this.deps.humanGate.request(input);
  }

  private async requestVerdictWithRetry(reviewRequest: string): Promise<ApprovalVerdictAttempt> {
    try {
      return await this.requestVerdictOnce(reviewRequest);
    } catch {
      // Inference failure or schema mismatch: retry once before escalating.
    }
    try {
      return await this.requestVerdictOnce(reviewRequest);
    } catch (error) {
      // Escalate to the human gate with the cause collapsed onto one line so the
      // progress log says why.
      const cause = getErrorMessage(error).replace(/\s+/gu, ' ').trim().slice(0, 200);
      return { kind: 'failure', reason: `verdict call failed: ${cause}` };
    }
  }

  private async requestVerdictOnce(reviewRequest: string): Promise<ApprovalVerdictAttempt> {
    const response = await this.deps.verdictRequester.requestApprovalVerdict(reviewRequest);
    if (response.toolCalls.length > 0) {
      return { kind: 'failure', reason: FORBIDDEN_TOOL_CALL_REASON };
    }
    return {
      kind: 'verdict',
      value: ApprovalVerdictSchema.parse(parseJsonValueText(String(response.text || ''))),
    };
  }

  private emitVerdict(input: ApprovalRequestInput, verdict: ApprovalVerdict['verdict'], reason: string): void {
    if (this.deps.evidenceRecorder && input.call) {
      this.deps.evidenceRecorder.recordApprovalReviewed({ call: input.call, toolName: input.toolName, command: input.command,
        verdict, reason, reviewedAtUtc: new Date().toISOString() });
    }
    this.deps.logger?.write({
      kind: 'approval_verdict',
      turn: input.turn,
      toolName: input.toolName,
      verdict,
      reason,
    });
    this.deps.progressWriter.write({
      kind: 'approval_auto',
      requestId: this.deps.requestId,
      turn: input.turn,
      toolName: input.toolName,
      command: input.command,
      verdict,
      reason,
    });
  }
}
