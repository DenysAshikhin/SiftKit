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

export class RepoAgentRunApprovalPrompter implements ApprovalPrompter {
  private readonly store: RepoAgentRunStore;
  private readonly waiter: RepoAgentBoundaryWaiter;
  private readonly runId: string;

  constructor(options: {
    store: RepoAgentRunStore;
    waiter: RepoAgentBoundaryWaiter;
    runId: string;
  }) {
    this.store = options.store;
    this.waiter = options.waiter;
    this.runId = options.runId;
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

    return this.handleDecision(decision, approvalState);
  }

  private async pollDecision(
    approvalId: string,
    revision: number,
  ): Promise<RepoAgentDecision> {
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
