import { z } from '../../lib/zod.js';
import { parseJsonValueText } from '../../lib/json.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../types.js';
import type { PlannerActionResponse } from '../planner-protocol.js';
import { isApprovalExemptReadOnlyTool, type ApprovalDecision, type ApprovalRequester, type ApprovalRequestInput } from './approval-gate.js';

const ApprovalVerdictSchema = z.object({
  verdict: z.enum(['approve', 'deny', 'unsure']),
  reason: z.string(),
});
type ApprovalVerdict = z.infer<typeof ApprovalVerdictSchema>;

/** Narrow view of TaskLoop: issues one ephemeral, schema-constrained verdict request. */
export type ApprovalVerdictRequester = {
  requestApprovalVerdict(question: string): Promise<PlannerActionResponse>;
};

export function buildApprovalVerdictQuestion(input: { toolName: string; command: string }): string {
  return [
    'You are now acting as an independent command reviewer, not the agent that proposed the action.',
    `Proposed action: tool "${input.toolName}" — ${input.command}`,
    '',
    'Decide whether this action should run:',
    '- approve: read-only, or clearly required by the task with effects confined to the repository working area.',
    '- deny: destructive or dangerous (recursive deletes, force-push, credential or secret access, sending data to external services), or unrelated to the task.',
    '- unsure: anything ambiguous — writes outside obvious task scope, package installs, long-running processes, or effects you cannot determine.',
    'When in doubt, prefer "unsure" over "approve".',
    'Respond with JSON: {"verdict":"approve"|"deny"|"unsure","reason":"<one sentence>"}',
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
    humanGate: ApprovalRequester;
    verdictRequester: ApprovalVerdictRequester;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  }) {}

  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    if (isApprovalExemptReadOnlyTool(input.toolName)) {
      this.emitVerdict(input, 'approve', 'read-only tool');
      return { kind: 'approve' };
    }
    const verdict = await this.requestVerdictWithRetry(buildApprovalVerdictQuestion(input));
    if (verdict === null) {
      this.emitVerdict(input, 'unsure', 'verdict call failed');
      return this.deps.humanGate.request(input);
    }
    this.emitVerdict(input, verdict.verdict, verdict.reason);
    if (verdict.verdict === 'approve') {
      return { kind: 'approve' };
    }
    if (verdict.verdict === 'deny') {
      return { kind: 'deny', reason: `auto-reviewer: ${verdict.reason}` };
    }
    return this.deps.humanGate.request(input);
  }

  private async requestVerdictWithRetry(question: string): Promise<ApprovalVerdict | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.deps.verdictRequester.requestApprovalVerdict(question);
        return ApprovalVerdictSchema.parse(parseJsonValueText(String(response.text || '')));
      } catch {
        // Inference failure or schema mismatch: retry once, then escalate to the human gate.
      }
    }
    return null;
  }

  private emitVerdict(input: ApprovalRequestInput, verdict: string, reason: string): void {
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
