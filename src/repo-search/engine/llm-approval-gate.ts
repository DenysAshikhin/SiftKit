import { getErrorMessage } from '../../lib/errors.js';
import { parseJsonValueText } from '../../lib/json.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../types.js';
import type { ChatMessage, PlannerActionResponse } from '../planner-protocol.js';
import {
  APPROVAL_PAYLOAD_LOCATOR_LINE,
  APPROVAL_REVIEW_POLICY_LINES,
  buildApprovalReviewRequest,
} from '../approval-review-policy.js';
import {
  isApprovalExemptReadOnlyTool,
  type ApprovalDecision,
  type ApprovalRequestInput,
  type HumanApprovalRequester,
} from './approval-gate.js';
import type { JsonLogger } from '../types.js';
import { ApprovalVerdictSchema, type ApprovalVerdict } from '../approval-verdict.js';

const FORBIDDEN_TOOL_CALL_REASON = 'approval reviewer attempted a forbidden tool call';

type ApprovalVerdictAttempt =
  | { kind: 'verdict'; value: ApprovalVerdict }
  | { kind: 'failure'; reason: string };

/** Narrow view of TaskLoop: issues one ephemeral, schema-constrained verdict request. */
export type ApprovalVerdictRequester = {
  requestApprovalVerdict(
    question: string,
    pendingMessages: ChatMessage[],
  ): Promise<PlannerActionResponse>;
};

export function buildApprovalVerdictQuestion(
  input: Pick<ApprovalRequestInput, 'toolName' | 'command' | 'reviewPayload'>,
): string {
  return [
    ...APPROVAL_REVIEW_POLICY_LINES,
    '',
    APPROVAL_PAYLOAD_LOCATOR_LINE,
    '',
    buildApprovalReviewRequest(input),
  ].join('\n');
}

/**
 * Decorator over the human ApprovalGate: asks the model itself for an
 * approve/deny/unsure verdict via an ephemeral request (the transcript is never
 * mutated, preserving the llama-cpp prompt-cache prefix). `unsure` and verdict
 * failures fall through to the wrapped human gate.
 */
export class LlmApprovalGate {
  constructor(private readonly deps: {
    requestId: string;
    humanGate: HumanApprovalRequester;
    verdictRequester: ApprovalVerdictRequester;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    logger: JsonLogger | null;
  }) {}

  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    // A read-only tool never reaches the reviewer. The exemption is static policy, not a verdict,
    // so it reports nothing: the tool_start line that follows already names the tool and its
    // arguments, and an approval line in front of it is pure duplication.
    if (isApprovalExemptReadOnlyTool(input.toolName)) {
      return { kind: 'approve' };
    }
    const verdict = await this.requestVerdictWithRetry(
      buildApprovalVerdictQuestion(input),
      input.pendingMessages,
    );
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

  private async requestVerdictWithRetry(
    question: string,
    pendingMessages: ChatMessage[],
  ): Promise<ApprovalVerdictAttempt> {
    try {
      return await this.requestVerdictOnce(question, pendingMessages);
    } catch {
      // Inference failure or schema mismatch: retry once before escalating.
    }
    try {
      return await this.requestVerdictOnce(question, pendingMessages);
    } catch (error) {
      // Escalate to the human gate with the cause collapsed onto one line so the
      // progress log says why.
      const cause = getErrorMessage(error).replace(/\s+/gu, ' ').trim().slice(0, 200);
      return { kind: 'failure', reason: `verdict call failed: ${cause}` };
    }
  }

  private async requestVerdictOnce(
    question: string,
    pendingMessages: ChatMessage[],
  ): Promise<ApprovalVerdictAttempt> {
    const response = await this.deps.verdictRequester.requestApprovalVerdict(question, pendingMessages);
    if (response.toolCalls.length > 0) {
      return { kind: 'failure', reason: FORBIDDEN_TOOL_CALL_REASON };
    }
    return {
      kind: 'verdict',
      value: ApprovalVerdictSchema.parse(parseJsonValueText(String(response.text || ''))),
    };
  }

  private emitVerdict(input: ApprovalRequestInput, verdict: string, reason: string): void {
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
