import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import type { ApprovalDecision } from '../repo-search/engine/approval-gate.js';
import type { ApprovalPrompter } from '../cli/approval-prompter.js';
import {
  RepoAgentApprovalSchema,
  RepoAgentDecisionSchema,
  type RepoAgentApproval,
  type RepoAgentDecision,
} from './run-schemas.js';
import type { RepoAgentRunStore } from './run-store.js';
import type { RepoAgentBoundaryWaiter } from './boundary-waiter.js';

const DEFAULT_DECISION_POLL_MS = 50;
export const DEFAULT_DECISION_TIMEOUT_MS = 600_000;

export class RepoAgentRunApprovalPrompter implements ApprovalPrompter {
  private readonly store: RepoAgentRunStore;
  private readonly waiter: RepoAgentBoundaryWaiter;
  private readonly runId: string;
  private readonly decisionTimeoutMs: number;

  constructor(options: {
    store: RepoAgentRunStore;
    waiter: RepoAgentBoundaryWaiter;
    runId: string;
    decisionTimeoutMs?: number;
  }) {
    this.store = options.store;
    this.waiter = options.waiter;
    this.runId = options.runId;
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    if (!Number.isFinite(this.decisionTimeoutMs) || this.decisionTimeoutMs <= 0) {
      throw new Error('Approval decision timeout must be a positive number of milliseconds.');
    }
  }

  async promptDecision(event: JsonObject): Promise<ApprovalDecision> {
    const reader = new JsonRecordReader(event);
    const requestId = reader.optionalString('requestId');
    const approvalId = reader.optionalString('approvalId');
    const toolName = reader.optionalString('toolName');
    const command = reader.optionalString('command');
    const reviewPayloadValue = reader.value('reviewPayload');

    if (!requestId) {
      throw new Error('Approval event missing requestId.');
    }
    if (!approvalId) {
      throw new Error('Approval event missing approvalId.');
    }
    if (!toolName) {
      throw new Error('Approval event missing toolName.');
    }
    if (!command) {
      throw new Error('Approval event missing command.');
    }
    if (
      reviewPayloadValue !== undefined
      && reviewPayloadValue !== null
      && typeof reviewPayloadValue !== 'string'
    ) {
      throw new Error('Approval event reviewPayload must be a string or null.');
    }
    const reviewPayload = typeof reviewPayloadValue === 'string'
      ? reviewPayloadValue
      : null;

    const current = this.store.readState(this.runId);
    const approval: RepoAgentApproval = RepoAgentApprovalSchema.parse({
      approvalId,
      toolName,
      command,
      reviewPayload,
    });

    const approvalState = this.store.publishApproval(
      this.runId,
      current.revision,
      approval,
    );
    const boundary = await this.waiter.waitForBoundary(current.revision);
    if (
      boundary.status !== 'approval_required'
      || boundary.approval.approvalId !== approval.approvalId
    ) {
      throw new Error('Published approval boundary was replaced before it could be observed.');
    }

    const decision = await this.pollDecision(
      approval.approvalId,
      approvalState.revision,
    );
    if (decision === null) {
      this.store.clearPendingApproval(this.runId, approvalState.revision, 'running');
      return {
        kind: 'deny',
        reason: `No approval decision was received within ${this.decisionTimeoutMs}ms; the command was not executed.`,
      };
    }

    return this.handleDecision(decision, approvalState);
  }

  private async pollDecision(
    approvalId: string,
    revision: number,
  ): Promise<RepoAgentDecision | null> {
    const deadline = Date.now() + this.decisionTimeoutMs;
    for (;;) {
      const decision = this.store.consumeDecision(
        this.runId,
        approvalId,
        revision,
      );
      if (decision) {
        return decision;
      }

      const state = this.store.readState(this.runId);
      if (state.status === 'aborted') {
        throw new Error('Run was aborted during approval wait.');
      }
      if (state.status === 'failed') {
        throw new Error(`Run failed during approval wait: ${state.error}`);
      }
      if (Date.now() >= deadline) {
        return null;
      }

      await this.sleep(DEFAULT_DECISION_POLL_MS);
    }
  }

  private handleDecision(
    decision: RepoAgentDecision,
    approvalState: ReturnType<RepoAgentRunStore['publishApproval']>,
  ): ApprovalDecision {
    const validated = RepoAgentDecisionSchema.parse(decision);

    switch (validated.decision) {
      case 'approve': {
        this.store.clearPendingApproval(
          this.runId,
          approvalState.revision,
          'running',
        );
        return { kind: 'approve' };
      }
      case 'deny': {
        this.store.clearPendingApproval(
          this.runId,
          approvalState.revision,
          'running',
        );
        return { kind: 'deny', reason: validated.reason };
      }
      case 'abort': {
        this.store.clearPendingApproval(
          this.runId,
          approvalState.revision,
          'aborted',
        );
        return { kind: 'abort' };
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
