import type {
  ApprovalDecision,
  ApprovalRequestInput,
  ApprovalRequester,
  HumanApprovalRequester,
  LiveApprovalMode,
} from './approval-gate.ts';

/**
 * Reads the live mode on every tool call so a run can switch between
 * off / interactive / auto while it is executing.
 */
export class ModeSwitchedApprovalRequester implements ApprovalRequester {
  private readonly liveMode: LiveApprovalMode;
  private readonly humanGate: HumanApprovalRequester;
  private readonly llmGate: ApprovalRequester;

  constructor(
    liveMode: LiveApprovalMode,
    humanGate: HumanApprovalRequester,
    llmGate: ApprovalRequester,
  ) {
    this.liveMode = liveMode;
    this.humanGate = humanGate;
    this.llmGate = llmGate;
  }

  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    switch (this.liveMode.mode) {
      case 'off':
        return Promise.resolve({ kind: 'approve' });
      case 'interactive':
        return this.humanGate.request(input);
      case 'auto':
        return this.llmGate.request(input);
    }
  }
}
