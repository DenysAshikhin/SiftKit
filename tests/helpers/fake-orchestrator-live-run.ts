import type { OrchestratorActivity } from '@siftkit/contracts';
import type { OrchestratorLiveRun } from '../../src/status-server/orchestrator-runs.ts';

/** A live run that holds its registry slot until aborted, with an empty live view. */
export class FakeLiveRun implements OrchestratorLiveRun {
  abortReason: string | null = null;
  private finish: () => void = () => {};
  readonly settled = new Promise<void>((resolve) => { this.finish = resolve; });
  readonly runId: string;
  private readonly onAbort: () => void;

  constructor(runId: string, onAbort: () => void = () => {}) {
    this.runId = runId;
    this.onAbort = onAbort;
  }
  abort(reason: string): void {
    this.abortReason = reason;
    this.onAbort();
    this.finish();
  }
  decide(): boolean {
    return false;
  }
  activitySnapshot(): OrchestratorActivity {
    return { runId: this.runId, schedule: null, parent: null, children: [] };
  }
}
