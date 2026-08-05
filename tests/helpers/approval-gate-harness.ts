import { ProgressWriter } from '../../src/lib/progress-writer.js';
import { ApprovalGate } from '../../src/repo-search/engine/approval-gate.js';
import type { RepoSearchProgressEvent } from '../../src/repo-search/types.js';

export class ApprovalGateHarness {
  public readonly controller = new AbortController();
  public readonly gate: ApprovalGate;

  constructor(
    progressWriter: ProgressWriter<RepoSearchProgressEvent>,
    bypassReadOnlyTools = false,
  ) {
    this.gate = new ApprovalGate({
      requestId: 'run-1',
      progressWriter,
      abortSignal: this.controller.signal,
      bypassReadOnlyTools,
    });
  }
}
