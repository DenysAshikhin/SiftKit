import type { OrchestratorActivity, OrchestratorChildActivity, OrchestratorParentActivity, OrchestratorSchedule } from '@siftkit/contracts';

import type { OperationProgressEvent } from '../repo-search/types.ts';
import type { OrchestratorRunRegistry } from '../status-server/orchestrator-runs.ts';
import type { RepoAgentSession } from '../status-server/repo-agent-sessions.ts';
import { reduceChildActivity } from './child-activity.ts';
import { IDLE_PARENT_ACTIVITY, reduceParentActivity } from './parent-activity.ts';

/** The parent streams thinking token by token; its view is published at most this often. */
const PARENT_PUBLISH_INTERVAL_MS = 250;

/** A run's in-memory view of its latest dispatch, its parent's conversation, and its running children. */
export class OrchestratorLiveActivity {
  private schedule: OrchestratorSchedule | null = null;
  private parent: OrchestratorParentActivity | null = null;
  private readonly children = new Map<string, OrchestratorChildActivity>();
  private readonly detachers = new Map<string, () => void>();
  private pendingPublish: NodeJS.Timeout | null = null;
  private lastPublishedAtMs = 0;
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

  /** Starts the parent's view with the exact prompt its conversation opens with. */
  startParent(prompt: { system: string; user: string }): void {
    this.parent = { ...IDLE_PARENT_ACTIVITY, prompt };
    this.publish();
  }

  /** The parent released its model while children or commands work, or took it back. */
  setParentParked(parked: boolean): void {
    if (this.parent === null || this.parent.parked === parked) return;
    this.parent = { ...this.parent, parked };
    this.publish();
  }

  applyParent(event: OperationProgressEvent): void {
    if (this.parent === null) return;
    const next = reduceParentActivity(this.parent, event);
    if (next === this.parent) return;
    this.parent = next;
    this.publishThrottled();
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
    return structuredClone({ runId: this.runId, schedule: this.schedule, parent: this.parent, children: [...this.children.values()] });
  }

  /** Stops a pending throttled frame; the run is over. */
  close(): void {
    if (this.pendingPublish !== null) clearTimeout(this.pendingPublish);
    this.pendingPublish = null;
  }

  private apply(childRunId: string, event: OperationProgressEvent): void {
    const current = this.children.get(childRunId);
    if (current === undefined) return;
    const next = reduceChildActivity(current, event);
    if (next === current) return;
    this.children.set(childRunId, next);
    this.publish();
  }

  private publishThrottled(): void {
    if (this.pendingPublish !== null) return;
    const waitMs = PARENT_PUBLISH_INTERVAL_MS - (Date.now() - this.lastPublishedAtMs);
    if (waitMs <= 0) {
      this.publish();
      return;
    }
    this.pendingPublish = setTimeout(() => this.publish(), waitMs);
  }

  private publish(): void {
    this.close();
    this.lastPublishedAtMs = Date.now();
    this.registry.publishActivity(this.snapshot());
  }
}
