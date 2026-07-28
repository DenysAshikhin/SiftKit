import { randomUUID } from 'node:crypto';

import { ensureStatusServerReachable } from '../config/index.js';
import {
  RepoAgentBoundaryWaiter,
  repoAgentStateToResult,
} from '../repo-agent/boundary-waiter.js';
import {
  RepoAgentDecisionSchema,
  RepoAgentRunResultSchema,
  RepoAgentWorkerRequestSchema,
  type RepoAgentRunResult,
} from '../repo-agent/run-schemas.js';
import type { RepoAgentRunStore } from '../repo-agent/run-store.js';
import type { RepoAgentProcessLauncher } from '../repo-agent/worker-launcher.js';
import type {
  RepoAgentInvocation,
} from './repo-agent-args.js';
import { runRepoAgentForegroundCli } from './run-repo-agent-foreground.js';

export type RepoAgentCommandStreams = {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export class RepoAgentCommand {
  private readonly store: RepoAgentRunStore;
  private readonly launcher: RepoAgentProcessLauncher;
  private readonly repoRoot: string;

  constructor(options: {
    store: RepoAgentRunStore;
    launcher: RepoAgentProcessLauncher;
    repoRoot: string;
  }) {
    this.store = options.store;
    this.launcher = options.launcher;
    this.repoRoot = options.repoRoot;
  }

  async run(
    invocation: RepoAgentInvocation,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    switch (invocation.kind) {
      case 'start':
        await ensureStatusServerReachable();
        return streams.stdin?.isTTY === true
          ? this.runTtyStart(invocation, streams)
          : this.runNonTtyStart(invocation, streams);
      case 'decide':
        return this.runDecision(invocation, streams);
      case 'status':
        return this.runStatus(invocation, streams);
    }
  }

  private runTtyStart(
    invocation: Extract<RepoAgentInvocation, { kind: 'start' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    return runRepoAgentForegroundCli({
      invocation,
      stdout: streams.stdout,
      stderr: streams.stderr,
      stdin: streams.stdin,
    });
  }

  private async runNonTtyStart(
    invocation: Extract<RepoAgentInvocation, { kind: 'start' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    const runId = randomUUID();
    const request = RepoAgentWorkerRequestSchema.parse({
      runId,
      task: invocation.task,
      repoRoot: this.repoRoot,
      approval: invocation.approval,
      progress: invocation.progress,
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
      ...(invocation.logFile === undefined
        ? {}
        : { logFile: invocation.logFile }),
    });
    this.store.create(request);
    try {
      this.launcher.launch(runId);
    } catch (error) {
      const state = this.store.readState(runId);
      if (state.status !== 'failed') {
        throw error;
      }
      return this.writeResult(repoAgentStateToResult(state), streams.stdout);
    }
    const result = await new RepoAgentBoundaryWaiter({
      store: this.store,
      runId,
    }).waitForBoundary(0);
    return this.writeResult(result, streams.stdout);
  }

  private async runDecision(
    invocation: Extract<RepoAgentInvocation, { kind: 'decide' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    const current = this.store.readState(invocation.runId);
    if (current.status !== 'approval_required') {
      throw new Error(`Run ${invocation.runId} has no pending approval.`);
    }
    const decision = RepoAgentDecisionSchema.parse(
      invocation.decision === 'deny'
        ? {
            runId: invocation.runId,
            approvalId: current.approval.approvalId,
            observedRevision: current.revision,
            decision: 'deny',
            reason: invocation.reason,
          }
        : {
            runId: invocation.runId,
            approvalId: current.approval.approvalId,
            observedRevision: current.revision,
            decision: invocation.decision,
          },
    );
    this.store.submitDecision(decision);
    const result = await new RepoAgentBoundaryWaiter({
      store: this.store,
      runId: invocation.runId,
    }).waitForBoundary(current.revision);
    return this.writeResult(result, streams.stdout);
  }

  private runStatus(
    invocation: Extract<RepoAgentInvocation, { kind: 'status' }>,
    streams: RepoAgentCommandStreams,
  ): number {
    const state = this.store.readState(invocation.runId);
    streams.stdout.write(`${JSON.stringify(state)}\n`);
    return 0;
  }

  private writeResult(
    input: RepoAgentRunResult,
    stdout: NodeJS.WritableStream,
  ): number {
    const result = RepoAgentRunResultSchema.parse(input);
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'completed' || result.status === 'approval_required'
      ? 0
      : 1;
  }
}
