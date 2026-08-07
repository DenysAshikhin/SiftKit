import { ProgressWriter } from '../../src/lib/progress-writer.js';
import { ApprovalGate } from '../../src/repo-search/engine/approval-gate.js';
import { ServerLogger } from '../../src/status-server/server-logger.js';
import type { RepoSearchProgressEvent } from '../../src/repo-search/types.js';

export class ApprovalGateHarness {
  public readonly controller = new AbortController();
  public readonly gate: ApprovalGate;
  public readonly logLines: string[] = [];

  constructor(
    progressWriter: ProgressWriter<RepoSearchProgressEvent>,
    bypassReadOnlyTools = false,
    decisionTimeoutMs?: number,
  ) {
    this.gate = new ApprovalGate({
      requestId: 'run-1',
      progressWriter,
      abortSignal: this.controller.signal,
      bypassReadOnlyTools,
      logger: new ServerLogger({
        level: 'debug',
        colour: false,
        write: (text: string) => { this.logLines.push(text); },
      }),
      ...(decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs }),
    });
  }
}
