import type { ApprovalMode } from '@siftkit/contracts';
import { ProgressWriter } from '../../src/lib/progress-writer.ts';
import { ApprovalGate } from '../../src/repo-search/engine/approval-gate.ts';
import { ServerLogger } from '../../src/status-server/server-logger.ts';
import type { RepoSearchProgressEvent } from '../../src/repo-search/types.ts';

export type ApprovalGateHarnessOptions = {
  mode: ApprovalMode;
  bypassReadOnlyTools?: boolean;
  decisionTimeoutMs?: number;
};

export class ApprovalGateHarness {
  public readonly controller = new AbortController();
  public readonly gate: ApprovalGate;
  public readonly logLines: string[] = [];

  constructor(progressWriter: ProgressWriter<RepoSearchProgressEvent>, options: ApprovalGateHarnessOptions) {
    this.gate = new ApprovalGate({
      requestId: 'run-1',
      progressWriter,
      abortSignal: this.controller.signal,
      mode: options.mode,
      bypassReadOnlyTools: options.bypassReadOnlyTools ?? false,
      logger: new ServerLogger({
        level: 'debug',
        colour: false,
        write: (text: string) => { this.logLines.push(text); },
      }),
      ...(options.decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs: options.decisionTimeoutMs }),
    });
  }
}
