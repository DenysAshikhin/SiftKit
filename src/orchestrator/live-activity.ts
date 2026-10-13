import type { OrchestratorActivity, OrchestratorChildActivity, OrchestratorSchedule } from '@siftkit/contracts';

import type { OperationProgressEvent } from '../repo-search/types.ts';
import type { OrchestratorRunRegistry } from '../status-server/orchestrator-runs.ts';
import type { RepoAgentSession } from '../status-server/repo-agent-sessions.ts';
import { reduceChildActivity } from './child-activity.ts';

/** A parent's in-memory view of its latest scheduler pass and running children, published on every visible change. */
export class OrchestratorLiveActivity {
  private schedule: OrchestratorSchedule | null = null;
  private readonly children = new Map<string, OrchestratorChildActivity>();
  private readonly detachers = new Map<string, () => void>();
  private readonly runId: string;
  private readonly registry: OrchestratorRunRegistry;

  constructor(runId: string, registry: OrchestratorRunRegistry) {
    this.runId = runId;
    this.registry = registry;
  }

  setSchedule(schedule: OrchestratorSchedule): void {
    this.schedule = schedule;
    this.publish();
  }

  /** Subscribes to the child's progress beside any other subscriber the session has. */
  track(session: Pick<RepoAgentSession, 'attach'>, child: { childRunId: string; taskId: string }): void {
    this.children.set(child.childRunId, { ...child, waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [] });
    this.detachers.set(child.childRunId, session.attach({
      wantsLiveText: false,
      writeProgress: (event) => this.apply(child.childRunId, event),
    }));
    this.publish();
  }

  untrack(childRunId: string): void {
    this.detachers.get(childRunId)?.();
    this.detachers.delete(childRunId);
    if (this.children.delete(childRunId)) this.publish();
  }

  /** A deep copy, so a subscriber can never change the view it was handed. */
  snapshot(): OrchestratorActivity {
    return structuredClone({ runId: this.runId, schedule: this.schedule, children: [...this.children.values()] });
  }

  private apply(childRunId: string, event: OperationProgressEvent): void {
    const current = this.children.get(childRunId);
    if (current === undefined) return;
    const next = reduceChildActivity(current, event);
    if (next === current) return;
    this.children.set(childRunId, next);
    this.publish();
  }

  private publish(): void {
    this.registry.publishActivity(this.snapshot());
  }
}
